import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyGuardContent, selectGuardContentCandidates} from "./guard-content-probe.ts";
import {readGuardContentPolicy, repositoryRoot} from "./policy.ts";

const bodyFileFlag = Flag.string("body-file").pipe(Flag.optional, Flag.withDescription("read the decision-record body from this file instead of stdin"));
const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("read newline-delimited changed paths from this file instead of stdin"));
const pathFlag = Flag.string("path").pipe(Flag.optional, Flag.withDescription("repository-relative path shown in the diagnostic"));
const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("Git ref whose policy is authoritative (default: worktree policy)"));

const readBody = (bodyFile: Option.Option<string>): string | null => {
	try {
		return Option.match(bodyFile, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => readFileSync(0, "utf8")});
	} catch {
		return null;
	}
};

const readPaths = (filesFrom: Option.Option<string>): ReadonlyArray<string> | null => {
	try {
		const raw = Option.match(filesFrom, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => readFileSync(0, "utf8")});
		return raw.split("\n");
	} catch {
		return null;
	}
};

const resolveRoot = (root: Option.Option<string>): string | null => {
	const requested = Option.getOrUndefined(root);
	return requested === undefined ? repositoryRoot() : resolve(requested);
};

const classify = Command.make(
	"classify",
	{bodyFile: bodyFileFlag, path: pathFlag, root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({bodyFile, path, root, policyRef}) {
		const resolvedRoot = resolveRoot(root);
		const loaded = resolvedRoot === null
			? {policy: null, trusted: false, source: "unresolved Git root", reason: "repository root could not be resolved"}
			: readGuardContentPolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
		const result = classifyGuardContent(readBody(bodyFile), loaded.policy);
		const label = Option.getOrElse(path, () => "(stdin decision record)");
		if (!loaded.trusted) yield* Console.error(`guard-content-probe: ${loaded.reason ?? "policy is unavailable"} (${loaded.source}) — fail-closed`);
		yield* Console.error(`guard-content-probe: ${label} → ${result.decision} [${result.reason}]; policy ${loaded.trusted ? "trusted" : "fail-closed"} from ${loaded.source}`);
		yield* Console.log(result.decision);
		if (result.decision === "not-guard-touching") return yield* Effect.sync(() => process.exit(1));
	}),
).pipe(Command.withDescription("Classify one decision-record body through repository-owned safeguard vocabulary; uncertain inputs are guard-touching"));

const candidates = Command.make(
	"candidates",
	{filesFrom: filesFromFlag, root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({filesFrom, root, policyRef}) {
		const paths = readPaths(filesFrom);
		if (paths === null) {
			yield* Console.error("guard-content-probe: changed paths could not be read — no candidate set can be proved");
			return yield* Effect.sync(() => process.exit(2));
		}
		const resolvedRoot = resolveRoot(root);
		const loaded = resolvedRoot === null
			? {policy: null, trusted: false, source: "unresolved Git root", reason: "repository root could not be resolved"}
			: readGuardContentPolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
		const selection = selectGuardContentCandidates(paths, loaded.policy, loaded.reason);
		if (!selection.trusted) yield* Console.error(`guard-content-probe: ${selection.reason ?? "policy is unavailable"} (${loaded.source}) — treating every changed path as a candidate`);
		for (const candidate of selection.paths) yield* Console.log(candidate);
	}),
).pipe(Command.withDescription("Select configured decision-record paths from newline-delimited changed paths; invalid policy selects every path"));

export const guardContentProbeCommand = Command.make("guard-content-probe").pipe(
	Command.withSubcommands([candidates, classify]),
	Command.withDescription("Shared, fail-closed decision-record safeguard-content classifier for review, delivery, and lightweight-review eligibility"),
);
