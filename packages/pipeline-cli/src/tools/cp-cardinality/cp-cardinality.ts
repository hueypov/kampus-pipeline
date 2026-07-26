/**
 * The pure protected-change approval decision. Provider adapters resolve authority
 * membership and current-revision evidence; this module only evaluates those facts.
 * It deliberately has no policy, repository, or network dependency.
 */

export type CpDecision = "discharge" | "stop";

/** The four deterministic authority-cardinality branches. */
export type CpBranch = "empty" | "single-owner-self" | "single-owner-other" | "multi-member";

export type CpReasonCode =
	| "invalid-required-non-author-approvals"
	| "invalid-non-author-approvals-at-head"
	| "blank-author"
	| "empty-approval-authority"
	| "sole-author-exception-present"
	| "sole-author-exception-missing"
	| "insufficient-non-author-approvals"
	| "required-approvals-exceed-authority-capacity"
	| "sufficient-non-author-approvals";

/**
 * Facts supplied by a repository-owned approval-evidence adapter. Counts must already
 * represent distinct, eligible non-author approvals bound to the current revision.
 */
export interface CpCardinalityInput {
	readonly members: ReadonlyArray<string>;
	readonly author: string;
	readonly requiredNonAuthorApprovals: number;
	readonly nonAuthorApprovalsAtHead: number;
	readonly soleAuthorExceptionAtHead: boolean;
}

export interface CpVerdict {
	readonly decision: CpDecision;
	/** Distinct non-blank approval-authority identities. `n` preserves the established command diagnostic. */
	readonly n: number;
	readonly memberCount: number;
	readonly branch: CpBranch;
	readonly requiredNonAuthorApprovals: number;
	readonly nonAuthorApprovalsAtHead: number;
	readonly reasonCode: CpReasonCode;
	readonly reason: string;
}

/** Trim and deduplicate exact identities. Case normalization belongs to the provider adapter. */
export const distinctMembers = (members: ReadonlyArray<string>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	for (const raw of members) {
		if (typeof raw !== "string") continue;
		const identity = raw.trim();
		if (identity !== "") seen.add(identity);
	}
	return [...seen];
};

const branchFor = (members: ReadonlyArray<string>, author: string): CpBranch => {
	if (members.length === 0) return "empty";
	if (members.length === 1) return members[0] === author ? "single-owner-self" : "single-owner-other";
	return "multi-member";
};

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const verdict = (
	decision: CpDecision,
	members: ReadonlyArray<string>,
	author: string,
	requiredNonAuthorApprovals: number,
	nonAuthorApprovalsAtHead: number,
	reasonCode: CpReasonCode,
	reason: string,
): CpVerdict => ({
	decision,
	n: members.length,
	memberCount: members.length,
	branch: branchFor(members, author),
	requiredNonAuthorApprovals,
	nonAuthorApprovalsAtHead,
	reasonCode,
	reason,
});

/**
 * Decide whether current-revision evidence discharges a protected-change hold.
 * Every invalid or insufficient fact returns `stop`; the only positive branch is
 * explicitly proven by the supplied adapter facts.
 */
export const decideCpCardinality = (input: CpCardinalityInput): CpVerdict => {
	const members = distinctMembers(input.members);
	const author = typeof input.author === "string" ? input.author.trim() : "";
	const threshold = input.requiredNonAuthorApprovals;
	const approvals = input.nonAuthorApprovalsAtHead;

	if (!isPositiveInteger(threshold)) {
		return verdict("stop", members, author, threshold, approvals, "invalid-required-non-author-approvals", "the required non-author approval threshold must be a positive integer — fail closed");
	}
	if (!isNonNegativeInteger(approvals)) {
		return verdict("stop", members, author, threshold, approvals, "invalid-non-author-approvals-at-head", "the current-revision non-author approval count must be a non-negative integer — fail closed");
	}
	if (author === "") {
		return verdict("stop", members, author, threshold, approvals, "blank-author", "the change author could not be resolved, so the authority branch cannot be proven — fail closed");
	}
	if (members.length === 0) {
		return verdict("stop", members, author, threshold, approvals, "empty-approval-authority", "the approval authority has no eligible members — fail closed");
	}

	const branch = branchFor(members, author);
	if (branch === "single-owner-self") {
		return input.soleAuthorExceptionAtHead
			? verdict("discharge", members, author, threshold, approvals, "sole-author-exception-present", "the proven sole-author exception is bound to the current revision")
			: verdict("stop", members, author, threshold, approvals, "sole-author-exception-missing", "the sole-author exception is not proven at the current revision");
	}

	const nonAuthorCapacity = members.filter((member) => member !== author).length;
	if (threshold > nonAuthorCapacity) {
		return verdict("stop", members, author, threshold, approvals, "required-approvals-exceed-authority-capacity", "the configured non-author approval threshold exceeds the available eligible authority capacity — fail closed");
	}
	if (approvals < threshold) {
		return verdict("stop", members, author, threshold, approvals, "insufficient-non-author-approvals", "the current revision has fewer eligible non-author approvals than the configured threshold");
	}
	return verdict("discharge", members, author, threshold, approvals, "sufficient-non-author-approvals", "the current revision has the configured number of eligible non-author approvals");
};
