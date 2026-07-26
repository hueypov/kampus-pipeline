import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyProtectedChanges, renderProtectedChangeRegex} from "./protected-change-policy.ts";
import {readProtectedChangePolicy, repositoryRoot} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("Git ref whose .pipeline/agent-policy.json is authoritative (default: worktree policy)"));
const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("read newline-delimited changed paths from this file instead of stdin"));

const resolveRoot = (root: Option.Option<string>): string | null => {
	const requested = Option.getOrUndefined(root);
	return requested === undefined ? repositoryRoot() : resolve(requested);
};

const readPaths = (filesFrom: Option.Option<string>): ReadonlyArray<string> | null => {
	try {
		const raw = Option.match(filesFrom, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => readFileSync(0, "utf8")});
		return raw.split("\n").map((path) => path.trim()).filter(Boolean);
	} catch {
		return null;
	}
};

const loadedPolicy = (root: Option.Option<string>, policyRef: Option.Option<string>) => {
	const resolvedRoot = resolveRoot(root);
	return resolvedRoot === null
		? {policy: null, trusted: false, source: "unresolved Git root", reason: "repository root could not be resolved"}
		: readProtectedChangePolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
};

const regex = Command.make(
	"regex",
	{root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({root, policyRef}) {
		const loaded = loadedPolicy(root, policyRef);
		if (!loaded.trusted || loaded.policy === null) {
			yield* Console.error(`protected-change-policy: ${loaded.reason ?? "policy is unavailable"} (${loaded.source}) — emitted match-all fallback`);
			yield* Console.log(".");
			return yield* Effect.sync(() => process.exit(2));
		}
		yield* Console.error(`protected-change-policy: ${loaded.policy.controlPlanePaths.length} configured protected pattern(s); policy trusted from ${loaded.source}`);
		yield* Console.log(renderProtectedChangeRegex(loaded.policy.controlPlanePaths));
	}),
).pipe(Command.withDescription("Emit the anchored POSIX ERE derived only from configured protected paths; invalid policy emits match-all and exits non-zero"));

const paths = Command.make(
	"paths",
	{root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({root, policyRef}) {
		const loaded = loadedPolicy(root, policyRef);
		if (!loaded.trusted || loaded.policy === null) {
			yield* Console.error(`protected-change-policy: ${loaded.reason ?? "policy is unavailable"} (${loaded.source})`);
			return yield* Effect.sync(() => process.exit(2));
		}
		for (const pattern of loaded.policy.controlPlanePaths) yield* Console.log(pattern);
	}),
).pipe(Command.withDescription("Print the configured protected-path patterns, one per line"));

const classify = Command.make(
	"classify",
	{filesFrom: filesFromFlag, root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({filesFrom, root, policyRef}) {
		const changedPaths = readPaths(filesFrom);
		const loaded = loadedPolicy(root, policyRef);
		if (changedPaths === null || !loaded.trusted || loaded.policy === null) {
			yield* Console.error(`protected-change-policy: ${changedPaths === null ? "changed paths could not be read" : loaded.reason ?? "policy is unavailable"} — defaulting to protected`);
			yield* Console.log("protected");
			return yield* Effect.sync(() => process.exit(2));
		}
		const result = classifyProtectedChanges(changedPaths, loaded.policy.controlPlanePaths);
		if (!result.trusted) {
			yield* Console.error(`protected-change-policy: ${result.reason ?? "classification failed"} — defaulting to protected`);
			yield* Console.log("protected");
			return yield* Effect.sync(() => process.exit(2));
		}
		yield* Console.error(`protected-change-policy: ${result.protectedPaths.length}/${changedPaths.length} changed path(s) protected; policy trusted from ${loaded.source}`);
		yield* Console.log(result.protectedPaths.length > 0 ? "protected" : "ordinary");
	}),
).pipe(Command.withDescription("Classify newline-delimited changed paths as protected or ordinary using the configured repository boundary"));

export const protectedChangePolicyCommand = Command.make("protected-change-policy").pipe(
	Command.withSubcommands([regex, paths, classify]),
	Command.withDescription("Read-only shared protected-change boundary authority backed by github.shipping.controlPlanePaths"),
);
