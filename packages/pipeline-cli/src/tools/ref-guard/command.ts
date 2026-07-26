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
const MARKER = "# kampus-pipeline ref-guard managed hook v1";

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

const cliBin = (): string => fileURLToPath(new URL("../../bin.ts", import.meta.url));

export const renderManagedHook = (bin = cliBin()): string => `#!/bin/sh
${MARKER}
# Git only aborts a reference transaction for this command's deliberate refusal.
status=0
"${process.execPath}" "${bin}" ref-guard reference-transaction "$1" || status=$?
[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1
exit 0
`;

export type HookState = "absent" | "installed" | "drifted" | "foreign";
export const inspectHook = (path: string, expected: string): HookState => {
	if (!existsSync(path)) return "absent";
	try {
		const actual = readFileSync(path, "utf8");
		if (actual === expected) return "installed";
		return actual.includes(MARKER) ? "drifted" : "foreign";
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
		if (existing === "absent") writeManagedHook(path, expected);
		yield* Console.log(`ref-guard: ${existing === "installed" ? "already installed" : "installed"} at ${path}${target.branch === null ? `; primary branch unresolved (${target.reason}), ref protection will activate when Git can resolve it` : ` for refs/heads/${target.branch}`}`);
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
		const refDecisions = updates.map((update) => decideRefUpdate(update, guardedRef, update.refName === guardedRef && update.newOid !== ZERO_OID ? comparisonFacts(root, comparisonRef, update.newOid) : {comparisonOid: null, comparisonIsAncestorOfNew: false}));
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
