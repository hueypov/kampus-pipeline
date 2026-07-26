export type GuardContentDecision = "guard-touching" | "not-guard-touching";

export type GuardContentReason =
	| "untrusted-policy"
	| "guard-content-disabled"
	| "unreadable-body"
	| "invalid-vocabulary-pattern"
	| "guard-vocabulary-match"
	| "no-match";

export type GuardContentPolicy = {
	readonly enabled: boolean;
	readonly decisionRecordPaths: ReadonlyArray<string>;
	readonly vocabularyPatterns: ReadonlyArray<string>;
};

export type GuardContentResult = {
	readonly decision: GuardContentDecision;
	readonly reason: GuardContentReason;
};

export type CandidateSelection = {
	readonly paths: ReadonlyArray<string>;
	readonly trusted: boolean;
	readonly reason: string | null;
};

const guardTouching = (reason: GuardContentReason): GuardContentResult => ({decision: "guard-touching", reason});
const ordinary = (): GuardContentResult => ({decision: "not-guard-touching", reason: "no-match"});

const completePolicy = (policy: GuardContentPolicy): boolean => {
	if (!policy.enabled) return policy.decisionRecordPaths.length === 0 && policy.vocabularyPatterns.length === 0;
	return policy.decisionRecordPaths.length > 0 && policy.vocabularyPatterns.length > 0;
};

const patternsAreValid = (policy: GuardContentPolicy): boolean => {
	try {
		policy.decisionRecordPaths.forEach((pattern) => new RegExp(pattern));
		policy.vocabularyPatterns.forEach((pattern) => new RegExp(pattern, "i"));
		return true;
	} catch {
		return false;
	}
};

const validPolicy = (policy: GuardContentPolicy): boolean => completePolicy(policy) && patternsAreValid(policy);

const uniqueNonEmptyPaths = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const path of paths) {
		const normalized = path.trim();
		if (normalized !== "" && !seen.has(normalized)) {
			seen.add(normalized);
			result.push(normalized);
		}
	}
	return result;
};

/**
 * Select changed paths that need their decision-record bodies examined. A policy that cannot
 * be trusted deliberately returns every path: callers must not prove a changed file ordinary
 * from a missing or malformed boundary.
 */
export const selectGuardContentCandidates = (
	paths: ReadonlyArray<string>,
	policy: GuardContentPolicy | null,
	reason: string | null = null,
): CandidateSelection => {
	const unique = uniqueNonEmptyPaths(paths);
	if (policy === null) return {paths: unique, trusted: false, reason: reason ?? "guard-content policy is unavailable"};
	if (!validPolicy(policy)) return {paths: unique, trusted: false, reason: "guard-content policy is incomplete or contains an invalid pattern"};
	if (!policy.enabled) return {paths: [], trusted: true, reason: null};
	const patterns = policy.decisionRecordPaths.map((pattern) => new RegExp(pattern));
	return {paths: unique.filter((path) => patterns.some((pattern) => pattern.test(path))), trusted: true, reason: null};
};

/**
 * Classify one already-selected decision-record body. This is intentionally total and
 * fail-closed: only a readable body under a trusted, enabled policy can be ordinary.
 */
export const classifyGuardContent = (
	body: string | null | undefined,
	policy: GuardContentPolicy | null,
): GuardContentResult => {
	if (policy === null) return guardTouching("untrusted-policy");
	if (!completePolicy(policy)) return guardTouching("untrusted-policy");
	if (!patternsAreValid(policy)) return guardTouching("invalid-vocabulary-pattern");
	if (!policy.enabled) return guardTouching("guard-content-disabled");
	if (body === null || body === undefined || body.trim() === "") return guardTouching("unreadable-body");
	const patterns = policy.vocabularyPatterns.map((pattern) => new RegExp(pattern, "i"));
	return patterns.some((pattern) => pattern.test(body)) ? guardTouching("guard-vocabulary-match") : ordinary();
};
