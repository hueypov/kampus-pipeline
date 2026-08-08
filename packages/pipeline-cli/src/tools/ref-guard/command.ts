/** Git-native reference transaction guard and its explicit local hook manager. */
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {readLifecyclePolicy, repositoryRoot, resolvePrimaryTarget} from "../lifecycle-policy.ts";
import {decideHeadDetach, decideRefUpdate, decideTransaction, type RefUpdate, ZERO_OID} from "./ref-guard.ts";

export const REFUSE_EXIT_CODE = 3;
const MARKER_PREFIX = "# pipeline ref-guard managed hook";
const MARKER = `${MARKER_PREFIX} v2`;
/**
 * The prefix every hook carried before the toolkit dropped its `kampus` names.
 *
 * A hook already on disk in a consumer repository still carries this. It is kept for RECOGNITION
 * only — nothing writes it again. Without it `inspectHook` reads an installed hook as `foreign`
 * (carrying no marker of ours) and refuses to touch it, so every repository that installed before
 * the rename would keep a stale guard that no `install` could ever repair.
 */
const LEGACY_MARKER_PREFIX = "# kampus-pipeline ref-guard managed hook";
/** The v1 marker, kept so a hook this tool wrote earlier is recognised as ours and upgraded. */
const MARKER_V1 = `${LEGACY_MARKER_PREFIX} v1`;

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

const primaryCheckout = (root: string): boolean => {
	const gitDir = runGit(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
	const commonDir = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	return gitDir.ok && commonDir.ok && gitDir.stdout.trim() !== "" && gitDir.stdout.trim() === commonDir.stdout.trim();
};

const comparisonFacts = (root: string, comparisonRef: string | null, newOid: string) => {
	if (comparisonRef === null) return {comparisonOid: null, comparisonIsAncestorOfNew: false};
	const resolved = runGit(root, ["rev-parse", "--verify", "--quiet", comparisonRef]);
	if (!resolved.ok || resolved.stdout.trim() === "") return {comparisonOid: null, comparisonIsAncestorOfNew: false};
	const ancestry = runGit(root, ["merge-base", "--is-ancestor", comparisonRef, newOid]);
	return {comparisonOid: resolved.stdout.trim(), comparisonIsAncestorOfNew: ancestry.ok};
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

/**
 * v2's body as this tool renders it today, but carrying the RETIRED marker — what an install from
 * before the de-brand left on disk. The body is otherwise byte-identical, so it is derived from the
 * live renderer rather than transcribed: a future edit to the hook cannot drift this shape out of
 * sync with it.
 */
const RECORDED_SENTINEL = "@@recorded@@";
const V2_LEGACY_LINES: ReadonlyArray<string | RegExp> = renderManagedHook(RECORDED_SENTINEL)
	.split("\n")
	.map((line, index) =>
		index === 1
			? `${LEGACY_MARKER_PREFIX} v2`
			// The recorded fallback path is baked at install time, so it is left open.
			: line.includes(RECORDED_SENTINEL) ? /^ {2}"[^"]*"$/ : line,
	);

const matchesShape = (actual: string, shape: ReadonlyArray<string | RegExp>): boolean => {
	const lines = actual.split("\n");
	if (lines.length !== shape.length) return false;
	return shape.every((want, i) => {
		const got = lines[i] ?? "";
		return typeof want === "string" ? got === want : want.test(got);
	});
};

/** A hook body this tool wrote in an earlier version, UNEDITED — the only kind `install` replaces. */
const isKnownManagedHook = (actual: string): boolean =>
	matchesShape(actual, V1_LINES) || matchesShape(actual, V2_LEGACY_LINES);

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
		if (!isKnownManagedHook(actual)) {
			return actual.includes(MARKER_PREFIX) || actual.includes(LEGACY_MARKER_PREFIX) ? "drifted" : "foreign";
		}
		return "outdated";
	} catch {
		return "foreign";
	}
};

const writeManagedHook = (path: string, body: string): void => {
	const temp = `${path}.pipeline-${process.pid}.tmp`;
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
		const refDecisions = updates.map((update) => decideRefUpdate(update, guardedRef, update.refName === guardedRef && update.newOid !== ZERO_OID && update.newOid !== update.oldOid ? comparisonFacts(root, comparisonRef, update.newOid) : {comparisonOid: null, comparisonIsAncestorOfNew: false}));
		const headDecision = decideHeadDetach(updates, {isPrimaryCheckout: primaryCheckout(root)});
		const verdict = decideTransaction([headDecision, ...refDecisions]);
		if (verdict.kind === "refuse") {
			yield* Console.error(`ref-guard: ${verdict.reason}`);
			return yield* Effect.sync(() => process.exit(REFUSE_EXIT_CODE));
		}
	}),
).pipe(Command.withDescription("Git reference-transaction hook boundary: refuse configured primary-ref divergence, deletion, and bare primary-checkout HEAD detach"));

export const refGuardCommand = Command.make("ref-guard").pipe(
	Command.withSubcommands([referenceTransaction, status, install, uninstall]),
	Command.withDescription("Generic caller-agnostic Git ref safety; installation is explicit and local"),
);
