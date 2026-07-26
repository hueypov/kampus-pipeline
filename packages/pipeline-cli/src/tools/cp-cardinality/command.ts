import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {type CpCardinalityInput, type CpVerdict, decideCpCardinality} from "./cp-cardinality.ts";
import {ghRestJson, readProtectedChangeApprovalPolicy, resolveGithubTeamEvidence} from "./evidence-github-team.ts";

const authorFlag = Flag.string("author").pipe(Flag.optional, Flag.withDescription("the protected change author identity"));
const requiredFlag = Flag.string("required-non-author-approvals").pipe(Flag.optional, Flag.withDescription("positive required count of eligible non-author approvals"));
const approvalsFlag = Flag.string("non-author-approvals-at-head").pipe(Flag.optional, Flag.withDescription("count of distinct eligible non-author approvals bound to the current revision"));
const soleAuthorExceptionFlag = Flag.boolean("sole-author-exception-at-head").pipe(Flag.withDescription("a configured sole-author exception is proven at the current revision"));
// Retained only for callers that still provide the original boolean evidence fact.
const legacyApprovalFlag = Flag.boolean("non-author-approval-at-head").pipe(Flag.withDescription("compatibility shorthand for one current-revision eligible non-author approval"));
const legacySelfApprovalFlag = Flag.boolean("self-approval-at-head").pipe(Flag.withDescription("compatibility alias for --sole-author-exception-at-head"));
const evidenceRootFlag = Flag.string("root").pipe(Flag.withDescription("repository root used only to read the immutable policy ref"));
const evidencePolicyRefFlag = Flag.string("policy-ref").pipe(Flag.withDescription("immutable base Git ref containing .pipeline/agent-policy.json"));
const evidenceRepoFlag = Flag.string("repo").pipe(Flag.withDescription("GitHub repository as owner/name"));
const evidencePrFlag = Flag.integer("pr").pipe(Flag.withDescription("pull request number whose live evidence is resolved"));

const INTEGER = /^(?:0|[1-9][0-9]*)$/;

const parseInteger = (raw: string | undefined): number | null =>
	raw !== undefined && INTEGER.test(raw) ? Number(raw) : null;

const readMembers = (): ReadonlyArray<string> | null => {
	try {
		return readFileSync(0, "utf8").split("\n");
	} catch {
		return null;
	}
};

const commandStop = (reason: string): CpVerdict => ({
	decision: "stop",
	n: 0,
	memberCount: 0,
	branch: "empty",
	requiredNonAuthorApprovals: Number.NaN,
	nonAuthorApprovalsAtHead: Number.NaN,
	reasonCode: "invalid-required-non-author-approvals",
	reason,
});

const render = (verdict: CpVerdict): string =>
	`cp-cardinality: branch=${verdict.branch} members=${verdict.memberCount} approvals=${verdict.nonAuthorApprovalsAtHead} threshold=${verdict.requiredNonAuthorApprovals} reason=${verdict.reasonCode} — ${verdict.reason}`;

const decide = Command.make(
	"decide",
	{
		author: authorFlag,
		required: requiredFlag,
		approvals: approvalsFlag,
		soleAuthorException: soleAuthorExceptionFlag,
		legacyApproval: legacyApprovalFlag,
		legacySelfApproval: legacySelfApprovalFlag,
	},
	Effect.fn(function* ({author, required, approvals, soleAuthorException, legacyApproval, legacySelfApproval}) {
		const members = readMembers();
		const rawRequired = Option.getOrUndefined(required);
		const rawApprovals = Option.getOrUndefined(approvals);
		const parsedRequired = parseInteger(rawRequired);
		const parsedApprovals = parseInteger(rawApprovals);
		let verdict: CpVerdict;

		if (members === null) {
			verdict = commandStop("the approval-authority roster could not be read from stdin — fail closed");
		} else if (rawRequired === undefined && !legacyApproval) {
			verdict = commandStop("--required-non-author-approvals is required unless the compatibility approval flag is supplied");
		} else if (rawRequired !== undefined && parsedRequired === null) {
			verdict = commandStop("--required-non-author-approvals must be a positive integer");
		} else if (rawApprovals !== undefined && parsedApprovals === null) {
			verdict = commandStop("--non-author-approvals-at-head must be a non-negative integer");
		} else if (legacyApproval && parsedApprovals !== null && parsedApprovals !== 1) {
			verdict = commandStop("the compatibility approval flag represents exactly one approval and contradicts the supplied count");
		} else {
			const input: CpCardinalityInput = {
				members,
				author: Option.getOrUndefined(author) ?? "",
				requiredNonAuthorApprovals: parsedRequired ?? 1,
				nonAuthorApprovalsAtHead: parsedApprovals ?? (legacyApproval ? 1 : 0),
				soleAuthorExceptionAtHead: soleAuthorException || legacySelfApproval,
			};
			verdict = decideCpCardinality(input);
		}

		yield* Console.error(render(verdict));
		yield* Console.log(verdict.decision);
		if (verdict.decision === "stop") return yield* Effect.sync(() => process.exit(1));
	}),
).pipe(Command.withDescription("Decide protected-change approval discharge from adapter-supplied authority and current-revision evidence"));

const evidenceGithubTeam = Command.make(
	"evidence-github-team",
	{root: evidenceRootFlag, policyRef: evidencePolicyRefFlag, repo: evidenceRepoFlag, pr: evidencePrFlag},
	Effect.fn(function* ({root, policyRef, repo, pr}) {
		const loaded = readProtectedChangeApprovalPolicy(root, policyRef);
		if (loaded.policy === null) {
			yield* Console.error(`cp-cardinality evidence-github-team: ${loaded.reason ?? "policy is unavailable"} (${loaded.source}) — fail closed`);
			return yield* Effect.sync(() => process.exit(1));
		}
		const result = resolveGithubTeamEvidence(loaded.policy, repo, pr, ghRestJson);
		if (!result.ok) {
			yield* Console.error(`cp-cardinality evidence-github-team: ${result.reason} — fail closed`);
			return yield* Effect.sync(() => process.exit(1));
		}
		yield* Console.log(JSON.stringify(result.facts));
	}),
).pipe(Command.withDescription("Resolve immutable-policy GitHub-team approval evidence into JSON facts for cp-cardinality decide"));

export const cpCardinalityCommand = Command.make("cp-cardinality").pipe(
	Command.withSubcommands([decide, evidenceGithubTeam]),
	Command.withDescription("Deterministic, network-free protected-change approval-cardinality decision authority"),
);
