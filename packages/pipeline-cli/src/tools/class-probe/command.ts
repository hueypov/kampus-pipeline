import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyPaths, FAIL_CLOSED_POLICY} from "./class-probe.ts";
import {readClassificationPolicy, repositoryRoot} from "./policy.ts";
import * as Exit from "../../exit-codes.ts";

const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("read newline-delimited changed paths from this file instead of stdin"));
const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("Git ref whose .pipeline/agent-policy.json is authoritative (default: worktree policy)"));
const namespacesFlag = Flag.boolean("namespaces").pipe(Flag.withDescription("print review-* namespaces instead of has-* artifact classes"));

const refuse = (message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`class-probe classify: ${message}\n`);
		process.exit(code);
	});

type PathRead =
	| {readonly ok: true; readonly source: string; readonly files: ReadonlyArray<string>}
	| {readonly ok: false; readonly source: string};

/**
 * Read the changed-path list, keeping a failed read and an empty read as different answers.
 *
 * Collapsing both to `[]` is how "I never read a diff" became "this diff requires no gate": a
 * missing `--files-from`, an unreadable fd, and a genuinely empty stdin all produced the same
 * classification, and "no review namespace" is a perfectly ordinary thing for this tool to say
 * (#94). Neither is a fact about the diff, and they route differently — an empty read is the
 * caller's input to fix, an unreadable one is the environment's.
 */
const readPaths = (filesFrom: Option.Option<string>): PathRead => {
	const source = Option.match(filesFrom, {onSome: (path) => `--files-from ${path}`, onNone: () => "stdin"});
	try {
		const raw = Option.match(filesFrom, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => readFileSync(0, "utf8")});
		return {ok: true, source, files: raw.split("\n").map((line) => line.trim()).filter(Boolean)};
	} catch {
		return {ok: false, source};
	}
};

const classify = Command.make(
	"classify",
	{filesFrom: filesFromFlag, root: rootFlag, policyRef: policyRefFlag, namespaces: namespacesFlag},
	Effect.fn(function* ({filesFrom, root, policyRef, namespaces}) {
		// Guarding the input before the root is resolved is what puts both exits from this verb behind
		// it: the unresolved-root branch below prints nothing for an empty diff and returns normally,
		// so a guard sited only on the main path would still fail open there.
		const read = readPaths(filesFrom);
		if (!read.ok) {
			return yield* refuse(`the changed-file list could not be read from ${read.source} — which namespaces this diff requires is UNKNOWN`, Exit.FAILED);
		}
		if (read.files.length === 0) {
			return yield* refuse(`${read.source} was read and held no changed paths — an unread diff is not a diff that requires no review`, Exit.EMPTY_INPUT);
		}
		const files = read.files;
		const requestedRoot = Option.getOrUndefined(root);
		const resolvedRoot = requestedRoot === undefined ? repositoryRoot() : resolve(requestedRoot);
		if (resolvedRoot === null) {
			const fallback = classifyPaths(files, FAIL_CLOSED_POLICY);
			yield* Console.error("class-probe: repository root could not be resolved — dispatching every review namespace for a non-empty diff");
			for (const item of namespaces ? fallback.namespaces : fallback.classes) yield* Console.log(item);
			return;
		}
		const loaded = readClassificationPolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
		const outcome = classifyPaths(files, loaded.policy);
		if (!loaded.trusted || !outcome.trusted) {
			yield* Console.error(`class-probe: ${loaded.reason ?? outcome.reason ?? "classification policy is unavailable"} (${loaded.source}) — dispatching every review namespace for a non-empty diff`);
		}
		yield* Console.error(`class-probe: ${files.length} changed file(s) → ${outcome.namespaces.length > 0 ? outcome.namespaces.join(", ") : "no review namespace"}; policy ${loaded.trusted && outcome.trusted ? "trusted" : "fail-closed"} from ${loaded.source}`);
		for (const item of namespaces ? outcome.namespaces : outcome.classes) yield* Console.log(item);
	}),
).pipe(Command.withDescription("Classify changed paths into inclusive artifact classes or required review namespaces using repository-owned policy"));

export const classProbeCommand = Command.make("class-probe").pipe(
	Command.withSubcommands([classify]),
	Command.withDescription("Fail-closed shared review-routing authority for reviewer dispatch, shipping, and CI verification"),
);
