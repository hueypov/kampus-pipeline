/** Git-native reference transaction guard and its explicit local hook manager. */
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {readLifecyclePolicy, repositoryRoot, resolvePrimaryTarget} from "../lifecycle-policy.ts";
import {decideHeadDetach, decideRefUpdate, decideTransaction, HEAD_REF, type RefUpdate, ZERO_OID} from "./ref-guard.ts";

export const REFUSE_EXIT_CODE = 3;
const MARKER_PREFIX = "# kampus-pipeline ref-guard managed hook";
const MARKER = `${MARKER_PREFIX} v2`;
/** The v1 marker, kept so a hook this tool wrote earlier is recognised as ours and upgraded. */
const MARKER_V1 = `${MARKER_PREFIX} v1`;

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root (default: current Git root)"));
const stateArg = Argument.string("state").pipe(Argument.withDescription("Git reference-transaction state; only prepared may refuse"));

const configuredRoot = (root: Option.Option<string>): string | null => Option.getOrUndefined(root) ?? repositoryRoot();

const fail = (message: string): Effect.Effect<never> => Effect.sync(() => {
	process.stderr.write(`ref-guard: ${message}\n`);
	process.exit(1);
});

const runGit = (root: string, args: ReadonlyArray<string>): {readonly ok: boolean; readonly stdout: string} => {
	try {
		return {ok: true, stdout: execFileSync("git", [...args], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]})};
	} catch {
		return {ok: false, stdout: ""};
	}
};

const parseUpdates = (stdin: string): ReadonlyArray<RefUpdate> => stdin.split("\n").flatMap((line) => {
	const fields = line.trim().split(/\s+/);
	return fields.length === 3 ? [{oldOid: fields[0] as string, newOid: fields[1] as string, refName: fields[2] as string}] : [];
});

/** Hooks must not wedge Git if stdin itself is unavailable; an unreadable stream is an empty transaction. */
const readStdin = (): Effect.Effect<string> => Effect.tryPromise({
	try: async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks).toString("utf8");
	},
	catch: () => new Error("reference-transaction stdin is unavailable"),
}).pipe(Effect.orElseSucceed(() => ""));

const commonDir = (root: string): string | null => {
	const result = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const dir = result.stdout.trim();
	return result.ok && dir !== "" ? dir : null;
};

const readTrimmed = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8").trim();
	} catch {
		return null;
	}
};

/** The reftable backend's whole-stack lock, per ref store. A `files` repository never has one. */
const STACK_LOCK = join("reftable", "tables.list.lock");

/** Whether any LINKED worktree's reftable stack is the one Git locked, rather than the shared one. */
const linkedStackLocked = (dir: string): boolean => {
	try {
		return readdirSync(join(dir, "worktrees")).some((name) => existsSync(join(dir, "worktrees", name, STACK_LOCK)));
	} catch {
		return false;
	}
};

/**
 * The value Git has staged for the shared primary checkout's own `HEAD` in this transaction, or
 * `null` when the shared HEAD is not the ref being written.
 *
 * `git-dir == git-common-dir` cannot answer this: it measures who INVOKED Git, so `git worktree add
 * --detach` run from the primary was refused even though it writes the NEW worktree's HEAD. The two
 * transactions are identical on stdin (`0000…0 <oid> HEAD`, zero-filled old value in both), in cwd,
 * in the environment, and in both `rev-parse` answers (measured on git 2.50.1). What separates them
 * is the ref-store lock `githooks(5)` promises at `prepared`: a ref lives in exactly one store, the
 * primary's rooted at `$GIT_COMMON_DIR` and a linked worktree's at `$GIT_COMMON_DIR/worktrees/<n>`.
 *
 * Mere EXISTENCE of the shared lock is still the wrong question, because Git takes it for every
 * write that dereferences through HEAD, not only for detaches: `commit`, `reset --hard` and `stash
 * push` in the primary all hold `$GIT_COMMON_DIR/HEAD.lock` while their own hook runs, and a stale
 * one outlives any interrupted Git. Either would refuse an unrelated `worktree add --detach` all
 * over again — the same bug, now intermittent. So this reads the lock instead of stat-ing it: Git
 * writes the pending value into it before renaming it over `HEAD`, measured as the transaction's
 * own new oid for a real primary detach, `ref: refs/heads/<branch>` for a branch switch, and EMPTY
 * for every deref-through-HEAD holder. Requiring it to equal the value on stdin scopes the fact to
 * this transaction; the one residual overlap is a concurrent primary detach to the very same oid,
 * which fails closed.
 *
 * Under `reftable` there is no per-ref lock and no staged value — only a whole-stack lock, which
 * every branch/tag/remote-ref write from ANY worktree takes, so it cannot carry the decision alone.
 * There the shared HEAD is under transaction when the shared stack is locked and no linked
 * worktree's stack is, which never mistakes a linked worktree's detach for the primary's and at
 * worst stands down while a linked worktree happens to be writing. The backend is read from the
 * store's shape rather than `git rev-parse --show-ref-format` (Git >= 2.45).
 */
const sharedHeadPending = (dir: string, headNewOid: string | null): string | null => {
	if (headNewOid === null) return null;
	if (existsSync(join(dir, "reftable"))) return existsSync(join(dir, STACK_LOCK)) && !linkedStackLocked(dir) ? headNewOid : null;
	return readTrimmed(join(dir, "HEAD.lock")) === headNewOid ? headNewOid : null;
};

/**
 * Markers Git writes for a multi-step operation it is driving itself, in the shared checkout.
 *
 * `rebase`, `pull --rebase` and `bisect start` detach the shared HEAD as a step and reattach it in
 * the same command. Refusing that first detach — indistinguishable on stdin from `git checkout
 * <sha>` — aborted an everyday rebase AND left `.git/rebase-merge` behind, so the operator had to
 * `git rebase --abort` out of a state the guard created. All three were measured writing their
 * marker BEFORE the detaching transaction fires (git 2.50.1).
 */
const IN_PROGRESS_MARKERS = ["rebase-merge", "rebase-apply", "BISECT_START"] as const;

const operationInProgress = (dir: string): boolean => IN_PROGRESS_MARKERS.some((marker) => existsSync(join(dir, marker)));

const comparisonFacts = (root: string, guardedRef: string, comparisonRef: string | null, newOid: string) => {
	const current = runGit(root, ["rev-parse", "--verify", "--quiet", guardedRef]);
	const currentOid = current.ok && current.stdout.trim() !== "" ? current.stdout.trim() : null;
	if (comparisonRef === null) return {comparisonOid: null, comparisonIsAncestorOfNew: false, currentOid};
	const resolved = runGit(root, ["rev-parse", "--verify", "--quiet", comparisonRef]);
	if (!resolved.ok || resolved.stdout.trim() === "") return {comparisonOid: null, comparisonIsAncestorOfNew: false, currentOid};
	const ancestry = runGit(root, ["merge-base", "--is-ancestor", comparisonRef, newOid]);
	return {comparisonOid: resolved.stdout.trim(), comparisonIsAncestorOfNew: ancestry.ok, currentOid};
};

export const hookPathFor = (root: string): string | null => {
	const result = runGit(root, ["rev-parse", "--git-path", "hooks/reference-transaction"]);
	return result.ok && result.stdout.trim() ? resolve(root, result.stdout.trim()) : null;
};

/**
 * The managed hook body.
 *
 * v1 baked the absolute path of the toolkit and of the node binary at INSTALL time, so a
 * repository that was later moved or re-cloned ran a hook that could not resolve — and `|| status`
 * swallowed the failure, leaving the guard off while the hook still looked installed.
 *
 * v2 resolves at RUN time from the repository root FIRST, and only falls back to the path recorded
 * at install time. The order is the fix: a moved repository finds its own toolkit and never
 * consults the stale path, while a repository whose toolkit genuinely lives elsewhere still works.
 * v1 had the fallback as its only mechanism, which is why moving anything broke it silently.
 *
 * When nothing resolves it says so in one line instead of a module-resolution stack trace, and
 * still exits 0: this is a `reference-transaction` hook, so a non-zero exit aborts the
 * transaction, and bricking every git operation in a moved clone is a worse failure than the one
 * being fixed. Loud, not fatal.
 */
const cliBin = (): string => fileURLToPath(new URL("../../bin.ts", import.meta.url));

export const renderManagedHook = (recorded = cliBin()): string => `#!/bin/sh
${MARKER}
# Git only aborts a reference transaction for this command's deliberate refusal.
# The toolkit and interpreter are resolved at run time — see ref-guard/command.ts.
status=0
root=$(git rev-parse --show-toplevel 2>/dev/null) || root=""
bin=""
for candidate in \\
  "$root/.pipeline/toolkit/packages/pipeline-cli/src/bin.ts" \\
  "$root/packages/pipeline-cli/src/bin.ts" \\
  "${recorded}"
do
  if [ -f "$candidate" ]; then bin="$candidate"; break; fi
done
if [ -z "$bin" ]; then
  echo "ref-guard: no toolkit under '$root' and none at the recorded path — THE GUARD IS NOT RUNNING; re-run pipeline init" >&2
  exit 0
fi
node_bin=$(command -v node 2>/dev/null) || node_bin=""
if [ -z "$node_bin" ]; then
  echo "ref-guard: no node on PATH — THE GUARD IS NOT RUNNING" >&2
  exit 0
fi
"$node_bin" "$bin" ref-guard reference-transaction "$1" || status=$?
[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1
exit 0
`;

/**
 * The exact v1 hook body, for every path this tool could have rendered it with.
 *
 * Matching the MARKER alone was not enough: a v1 hook someone had edited by hand still carried the
 * marker, so it read as ours-and-untouched and `install` overwrote the edit silently — the precise
 * outcome the `drifted` refusal exists to prevent. Comparing against the rendering distinguishes
 * "ours, untouched" from "ours, edited", which is what the state names claim to mean.
 *
 * v1's body varied only in the two absolute paths it baked, so the comparison is structural: same
 * shape, any interpreter, any bin.
 */
/** v1's invocation line, with the two absolute paths it baked left open. */
const V1_INVOCATION = /^"[^"]*" "[^"]*" ref-guard reference-transaction "\$1" \|\| status=\$\?$/;

/**
 * v1's body as a line-by-line shape. A regex over the whole body would say the same thing far less
 * legibly, and this has to stay readable: it is the predicate deciding whether we may overwrite
 * somebody's file.
 */
const V1_LINES: ReadonlyArray<string | RegExp> = [
	"#!/bin/sh",
	MARKER_V1,
	"# Git only aborts a reference transaction for this command's deliberate refusal.",
	"status=0",
	V1_INVOCATION,
	`[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1`,
	"exit 0",
	"",
];

/** A hook body this tool wrote in an earlier version, UNEDITED — the only kind `install` replaces. */
const isKnownManagedHook = (actual: string): boolean => {
	const lines = actual.split("\n");
	if (lines.length !== V1_LINES.length) return false;
	return V1_LINES.every((want, i) => {
		const got = lines[i] ?? "";
		return typeof want === "string" ? got === want : want.test(got);
	});
};

export type HookState = "absent" | "installed" | "outdated" | "drifted" | "foreign";

/**
 * Who owns the hook at `path`, and whether we may replace it.
 *
 * `outdated` is the state that makes a moved repository repairable: a hook carrying one of OUR
 * markers, whose body is exactly a rendering this tool produced, is ours to upgrade. A hook that
 * carries a marker but matches no rendering we know is `drifted` — someone edited it by hand, and
 * overwriting that would discard their change silently.
 */
export const inspectHook = (path: string, expected: string): HookState => {
	if (!existsSync(path)) return "absent";
	try {
		const actual = readFileSync(path, "utf8");
		if (actual === expected) return "installed";
		// Carries one of our markers but is not a rendering we produced ⇒ hand-edited ⇒ refuse.
		if (!isKnownManagedHook(actual)) return actual.includes(MARKER_PREFIX) ? "drifted" : "foreign";
		return "outdated";
	} catch {
		return "foreign";
	}
};

const writeManagedHook = (path: string, body: string): void => {
	const temp = `${path}.kampus-pipeline-${process.pid}.tmp`;
	writeFileSync(temp, body, {mode: 0o755});
	chmodSync(temp, 0o755);
	renameSync(temp, path);
};

const status = Command.make(
	"status",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		const projectRoot = configuredRoot(root);
		if (projectRoot === null) return yield* Console.error("ref-guard: not inside a Git repository");
		const policy = readLifecyclePolicy(projectRoot);
		const target = resolvePrimaryTarget(projectRoot, policy);
		const hookPath = hookPathFor(projectRoot);
		const state = hookPath === null ? "unavailable" : inspectHook(hookPath, renderManagedHook());
		yield* Console.log(`ref-guard: primary ${target.branch ?? "unresolved"}; remote ${target.remote ?? "unresolved"} (${target.reason})`);
		yield* Console.log(`ref-guard: hook ${state}${hookPath === null ? "" : ` at ${hookPath}`}`);
	}),
).pipe(Command.withDescription("Report generic ref-guard policy, primary-ref resolution, and local hook ownership without changing Git"));

const install = Command.make(
	"install",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		const projectRoot = configuredRoot(root);
		if (projectRoot === null) return yield* fail("not inside a Git repository; no hook installed");
		const policy = readLifecyclePolicy(projectRoot);
		const target = resolvePrimaryTarget(projectRoot, policy);
		const path = hookPathFor(projectRoot);
		if (path === null) return yield* fail("Git did not provide a hook path; no hook installed");
		const expected = renderManagedHook();
		const existing = inspectHook(path, expected);
		if (existing === "foreign" || existing === "drifted") return yield* fail(`${existing} reference-transaction hook at ${path}; refusing to overwrite it`);
		// `outdated` is a hook THIS tool wrote in an earlier version, so it is ours to replace —
		// and replacing it is what repairs a repository initialized before the hook resolved its
		// toolkit at run time. Reporting without writing would leave the guard off while claiming
		// it was installed, which is the same class of silence this whole change exists to remove.
		if (existing === "absent" || existing === "outdated") writeManagedHook(path, expected);
		const action =
			existing === "installed" ? "already installed" : existing === "outdated" ? "upgraded" : "installed";
		yield* Console.log(`ref-guard: ${action} at ${path}${target.branch === null ? `; primary branch unresolved (${target.reason}), ref protection will activate when Git can resolve it` : ` for refs/heads/${target.branch}`}`);
	}),
).pipe(Command.withDescription("Explicitly install the managed local reference-transaction hook; never overwrites a foreign hook"));

const uninstall = Command.make(
	"uninstall",
	{root: rootFlag},
	Effect.fn(function* ({root}) {
		const projectRoot = configuredRoot(root);
		if (projectRoot === null) return yield* fail("not inside a Git repository; no hook removed");
		const path = hookPathFor(projectRoot);
		if (path === null) return yield* fail("Git did not provide a hook path; no hook removed");
		const state = inspectHook(path, renderManagedHook());
		if (state === "absent") return yield* Console.log("ref-guard: managed hook is already absent");
		if (state !== "installed") return yield* fail(`${state} hook at ${path}; refusing to remove it`);
		unlinkSync(path);
		yield* Console.log(`ref-guard: removed managed hook at ${path}`);
	}),
).pipe(Command.withDescription("Remove only the exact managed local reference-transaction hook"));

const referenceTransaction = Command.make(
	"reference-transaction",
	{state: stateArg},
	Effect.fn(function* ({state}) {
		const updates = parseUpdates(yield* readStdin());
		if (state !== "prepared") return;
		const root = repositoryRoot();
		if (root === null) return;
		const policy = readLifecyclePolicy(root);
		const target = resolvePrimaryTarget(root, policy);
		if (target.branch === null) return;
		const guardedRef = `refs/heads/${target.branch}`;
		const comparisonRef = target.remote === null ? null : `refs/remotes/${target.remote}/${target.branch}`;
		// Facts are gathered only for updates the pure ladder will actually test against them: a
		// same-value write is decided before the ancestry rung, so probing it would spawn two git
		// processes per stash/reset whose answers are discarded.
		const refDecisions = updates.map((update) => decideRefUpdate(update, guardedRef, update.refName === guardedRef && update.newOid !== ZERO_OID && update.newOid !== update.oldOid ? comparisonFacts(root, guardedRef, comparisonRef, update.newOid) : {comparisonOid: null, comparisonIsAncestorOfNew: false, currentOid: null}));
		const dir = commonDir(root);
		const headNewOid = updates.find((update) => update.refName === HEAD_REF)?.newOid ?? null;
		const headDecision = dir === null
			? {kind: "allow" as const, reason: "Git did not report a common directory"}
			: decideHeadDetach(updates, {sharedHeadPending: sharedHeadPending(dir, headNewOid), operationInProgress: operationInProgress(dir)});
		const verdict = decideTransaction([headDecision, ...refDecisions]);
		if (verdict.kind === "refuse") {
			yield* Console.error(`ref-guard: ${verdict.reason}`);
			// The HEAD rung's evidence is the value staged in the shared HEAD lock, which a Git that
			// was killed mid-write leaves behind. That is the one refusal an operator can hit without
			// doing anything wrong, and the file naming it is the whole recovery, so say it.
			if (verdict === headDecision && dir !== null) yield* Console.error(`ref-guard: evidence is the value staged in ${join(dir, "HEAD.lock")}; if no checkout is running, that lock is stale and can be removed`);
			return yield* Effect.sync(() => process.exit(REFUSE_EXIT_CODE));
		}
	}),
).pipe(Command.withDescription("Git reference-transaction hook boundary: refuse configured primary-ref divergence, deletion, and bare primary-checkout HEAD detach"));

export const refGuardCommand = Command.make("ref-guard").pipe(
	Command.withSubcommands([referenceTransaction, status, install, uninstall]),
	Command.withDescription("Generic caller-agnostic Git ref safety; installation is explicit and local"),
);
