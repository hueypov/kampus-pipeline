import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyPaths, FAIL_CLOSED_POLICY} from "./class-probe.ts";
import {readClassificationPolicy, repositoryRoot} from "./policy.ts";

const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("read newline-delimited changed paths from this file instead of stdin"));
const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("Git ref whose .pipeline/agent-policy.json is authoritative (default: worktree policy)"));
const namespacesFlag = Flag.boolean("namespaces").pipe(Flag.withDescription("print review-* namespaces instead of has-* artifact classes"));

const readPaths = (filesFrom: Option.Option<string>): ReadonlyArray<string> => {
	try {
		const raw = Option.match(filesFrom, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => readFileSync(0, "utf8")});
		return raw.split("\n").map((line) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
};

const classify = Command.make(
	"classify",
	{filesFrom: filesFromFlag, root: rootFlag, policyRef: policyRefFlag, namespaces: namespacesFlag},
	Effect.fn(function* ({filesFrom, root, policyRef, namespaces}) {
		const requestedRoot = Option.getOrUndefined(root);
		const resolvedRoot = requestedRoot === undefined ? repositoryRoot() : resolve(requestedRoot);
		const files = readPaths(filesFrom);
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
