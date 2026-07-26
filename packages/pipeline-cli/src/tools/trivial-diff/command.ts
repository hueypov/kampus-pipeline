import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyPaths, FAIL_CLOSED_POLICY} from "../class-probe/class-probe.ts";
import {readClassificationPolicy} from "../class-probe/policy.ts";
import {selectGuardContentCandidates} from "../guard-content-probe/guard-content-probe.ts";
import {readGuardContentPolicy} from "../guard-content-probe/policy.ts";
import {classifyProtectedChanges} from "../protected-change-policy/protected-change-policy.ts";
import {readProtectedChangePolicy} from "../protected-change-policy/policy.ts";
import {readTrivialDiffPolicy, repositoryRoot} from "./policy.ts";
import {selectTrivialDiffRoute} from "./route.ts";
import {changedPathsFromUnifiedDiff, classifyTrivialDiff} from "./trivial-diff.ts";

const diffFileFlag = Flag.string("diff-file").pipe(Flag.optional, Flag.withDescription("read a unified diff from this file instead of stdin"));
const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("Git ref whose .pipeline/agent-policy.json is authoritative (default: worktree policy)"));
const reducedGateSupportedFlag = Flag.boolean("reduced-gate-supported").pipe(Flag.withDescription("assert that this workflow can emit the same SHA-bound verdict contract through review-trivial"));

const readDiff = (path: Option.Option<string>): string | null => {
	try {
		return Option.match(path, {onSome: (file) => readFileSync(file, "utf8"), onNone: () => readFileSync(0, "utf8")});
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
	{diffFile: diffFileFlag, root: rootFlag, policyRef: policyRefFlag},
	Effect.fn(function* ({diffFile, root: requestedRoot, policyRef}) {
		const root = resolveRoot(requestedRoot);
		const policy = root === null ? null : readTrivialDiffPolicy(root, Option.getOrUndefined(policyRef) ?? null);
		const guardContent = root === null ? null : readGuardContentPolicy(root, Option.getOrUndefined(policyRef) ?? null);
		const diff = readDiff(diffFile);
		if (policy === null || !policy.trusted || policy.policy === null || diff === null) {
			yield* Console.error(`trivial-diff: ${policy === null ? "repository root could not be resolved" : !policy.trusted ? policy.reason ?? "policy is unavailable" : "diff could not be read"} — default-deny`);
			yield* Console.log("non-trivial");
			return;
		}
		const result = classifyTrivialDiff(diff, policy.policy.maxChangedLines, policy.policy.protectedPaths, guardContent?.policy ?? null);
		yield* Console.error(`trivial-diff: ${result.reason}`);
		yield* Console.log(result.verdict);
	}),
).pipe(Command.withDescription("Classify a unified diff as trivial or non-trivial; every uncertainty routes to full review"));

const route = Command.make(
	"route",
	{diffFile: diffFileFlag, root: rootFlag, policyRef: policyRefFlag, reducedGateSupported: reducedGateSupportedFlag},
	Effect.fn(function* ({diffFile, root: requestedRoot, policyRef, reducedGateSupported}) {
		const root = resolveRoot(requestedRoot);
		const ref = Option.getOrUndefined(policyRef) ?? null;
		const diff = readDiff(diffFile);
		const trivialPolicy = root === null ? null : readTrivialDiffPolicy(root, ref);
		const classificationPolicy = root === null ? null : readClassificationPolicy(root, ref);
		const protectedPolicy = root === null ? null : readProtectedChangePolicy(root, ref);
		const guardPolicy = root === null ? null : readGuardContentPolicy(root, ref);
		const changedPaths = diff === null ? null : changedPathsFromUnifiedDiff(diff);
		const classifier = diff !== null && trivialPolicy?.trusted && trivialPolicy.policy !== null
			? classifyTrivialDiff(diff, trivialPolicy.policy.maxChangedLines, trivialPolicy.policy.protectedPaths, guardPolicy?.policy ?? null)
			: null;
		const pathClassification = changedPaths === null
			? classifyPaths([], FAIL_CLOSED_POLICY)
			: classifyPaths(changedPaths, classificationPolicy?.policy ?? FAIL_CLOSED_POLICY);
		const protectedResult = changedPaths !== null && protectedPolicy?.trusted && protectedPolicy.policy !== null
			? classifyProtectedChanges(changedPaths, protectedPolicy.policy.controlPlanePaths)
			: null;
		const guardCandidates = changedPaths === null
			? null
			: selectGuardContentCandidates(changedPaths, guardPolicy?.policy ?? null, guardPolicy?.reason ?? "guard-content policy is unavailable");
		const decision = selectTrivialDiffRoute({
			enabled: trivialPolicy?.trusted === true && trivialPolicy.policy?.enabled === true,
			classifier,
			namespaces: pathClassification.namespaces,
			namespacesTrusted: classificationPolicy?.trusted === true && pathClassification.trusted && changedPaths !== null,
			protectedChange: protectedResult === null || !protectedResult.trusted ? "unknown" : protectedResult.protectedPaths.length > 0 ? "protected" : "ordinary",
			hasGuardContentCandidate: guardCandidates === null || !guardCandidates.trusted || guardCandidates.paths.length > 0,
			reducedGateSupported,
		});
		yield* Console.error(`trivial-diff route: ${decision.reason}; policy ${ref === null ? "worktree" : `immutable ${ref}`}`);
		yield* Console.log(decision.route);
	}),
).pipe(Command.withDescription("Select review-trivial only when immutable policy and every shared protected-change authority prove the reduced route is safe"));

export const trivialDiffCommand = Command.make("trivial-diff").pipe(
	Command.withSubcommands([classify, route]),
	Command.withDescription("Fail-closed lightweight-review classifier and single shared route authority; uncertainty always selects full review"),
);
