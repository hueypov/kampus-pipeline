/**
 * Read-only command boundary for the generic primary-index guard.  It performs
 * Git probes and optional JSONL attribution but never alters an index, worktree,
 * ref, branch, or remote.
 */
import {execFileSync} from "node:child_process";
import {appendFileSync} from "node:fs";
import {resolve} from "node:path";
import {tmpdir} from "node:os";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {
	decidePrimaryIndexCommit,
	decidePrimaryIndexRecord,
	parseNameStatus,
	type PrimaryIndexAttribution,
} from "./primary-index-guard.ts";
import {readPrimaryIndexGuardPolicy} from "./policy.ts";

/** Dedicated signal for a positively-established policy violation. */
export const REFUSE_EXIT_CODE = 3;

const gitResult = (args: readonly string[], cwd = process.cwd()): {readonly ok: boolean; readonly stdout: string} => {
	try {
		return {ok: true, stdout: execFileSync("git", [...args], {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]})};
	} catch {
		return {ok: false, stdout: ""};
	}
};

const runGit = (args: readonly string[], cwd = process.cwd()): string | null => {
	const result = gitResult(args, cwd);
	const value = result.stdout.trim();
	return result.ok && value !== "" ? value : null;
};

export const repositoryRoot = (cwd = process.cwd()): string | null => runGit(["rev-parse", "--show-toplevel"], cwd);

/** Equality is proof of the shared checkout; any failed/empty probe is deliberately not proof. */
export const detectPrimaryCheckout = (cwd = process.cwd()): boolean => {
	const gitDir = runGit(["rev-parse", "--path-format=absolute", "--git-dir"], cwd);
	const commonDir = runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	return gitDir !== null && commonDir !== null && resolve(gitDir) === resolve(commonDir);
};

const stagedEntries = (cwd = process.cwd()) => {
	const staged = gitResult(["diff", "--cached", "--name-status", "--diff-filter=D"], cwd);
	return staged.ok ? parseNameStatus(staged.stdout) : null;
};

const defaultLogPath = (): string => resolve(tmpdir(), "pipeline-primary-index-guard.jsonl");

/** Best-effort only: observability never modifies the enforcement outcome. */
export const appendAttribution = (path: string, record: PrimaryIndexAttribution & {readonly blocked?: boolean}): boolean => {
	try {
		appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
		return true;
	} catch {
		return false;
	}
};

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const logFlag = Flag.string("log").pipe(Flag.optional, Flag.withDescription("override the repository policy's optional attribution JSONL destination"));

const facts = (root: string, cwd = process.cwd()) => {
	const staged = stagedEntries(cwd);
	const loaded = readPrimaryIndexGuardPolicy(root);
	if (staged === null || !loaded.trusted || loaded.policy === null) return {staged: null, loaded};
	return {
		staged,
		loaded,
		input: {
			onPrimaryCheckout: detectPrimaryCheckout(cwd),
			staged,
			policy: loaded.policy,
			cwd,
			operator: process.env.PIPELINE_OPERATOR ?? process.env.USER ?? "",
			sessionId: process.env.PIPELINE_SESSION_ID ?? "",
			at: new Date().toISOString(),
		},
	};
};

const chosenLogPath = (configured: string | null, override: Option.Option<string>): string =>
	override._tag === "Some" ? override.value : configured ?? defaultLogPath();

const unavailable = (reason: string) => Console.error(`primary-index-guard: ${reason}; allowing because enforcement could not be established`);

const preCommit = Command.make(
	"pre-commit",
	{root: rootFlag, log: logFlag},
	Effect.fn(function* ({root: requestedRoot, log}) {
		const root = requestedRoot._tag === "Some" ? requestedRoot.value : repositoryRoot();
		if (root === null) return yield* unavailable("not inside a Git repository");
		const observed = facts(root, root);
		if (!observed.loaded.trusted || observed.loaded.policy === null) return yield* unavailable(observed.loaded.reason);
		if (observed.staged === null || !("input" in observed)) return yield* unavailable("could not read staged deletions");
		const decision = decidePrimaryIndexCommit(observed.input);
		if (decision.kind === "allow") return;
		if (observed.loaded.policy.attribution.enabled) {
			const path = chosenLogPath(observed.loaded.policy.attribution.logPath, log);
			if (!appendAttribution(path, {...decision.record, blocked: true})) yield* Console.error("primary-index-guard: could not append optional attribution record");
		}
		yield* Console.error(`primary-index-guard REFUSED: ${decision.reason} Affected sample: ${decision.record.sampleProtectedDeletions.join(", ") || "none"}`);
		return yield* Effect.sync(() => process.exit(REFUSE_EXIT_CODE));
	}),
).pipe(Command.withDescription("Git pre-commit containment check: exits 3 only for a proven primary-checkout protected deletion threshold violation"));

const record = Command.make(
	"record",
	{root: rootFlag, log: logFlag},
	Effect.fn(function* ({root: requestedRoot, log}) {
		const root = requestedRoot._tag === "Some" ? requestedRoot.value : repositoryRoot();
		if (root === null) return yield* Console.error("primary-index-guard: record skipped outside a Git repository");
		const observed = facts(root, root);
		if (!observed.loaded.trusted || observed.loaded.policy === null) return yield* Console.error(`primary-index-guard: record skipped: ${observed.loaded.reason}`);
		if (observed.staged === null || !("input" in observed)) return yield* Console.error("primary-index-guard: record skipped: could not read staged deletions");
		const decision = decidePrimaryIndexRecord(observed.input);
		if (decision.kind === "quiet") return;
		const path = chosenLogPath(observed.loaded.policy.attribution.logPath, log);
		if (!appendAttribution(path, decision.record)) yield* Console.error("primary-index-guard: optional attribution record could not be written");
	}),
).pipe(Command.withDescription("Best-effort read-only JSONL attribution for qualifying protected staged deletions; always exits 0"));

export const primaryIndexGuardCommand = Command.make("primary-index-guard").pipe(
	Command.withSubcommands([preCommit, record]),
	Command.withDescription("Repository-configured primary-checkout staged-deletion containment and optional attribution"),
);
