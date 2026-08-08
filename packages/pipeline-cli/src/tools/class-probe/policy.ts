import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {FAIL_CLOSED_POLICY, type ClassificationPolicy, type PatternSet} from "./class-probe.ts";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type LoadedClassificationPolicy = {
	readonly policy: ClassificationPolicy;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const patterns = (value: unknown, allowEmpty = false): ReadonlyArray<string> | null =>
	Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
		? value
		: null;

const parsePatternSet = (value: unknown, allowEmptyIncludes = false): PatternSet | null => {
	if (!isRecord(value)) return null;
	const includePatterns = patterns(value.includePatterns, allowEmptyIncludes);
	const excludePatterns = patterns(value.excludePatterns, true);
	return includePatterns === null || excludePatterns === null ? null : {includePatterns, excludePatterns};
};

/** Parse the additive policy section atomically; callers never receive a partially trusted route. */
export const parseClassificationPolicy = (raw: unknown): ClassificationPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.review)) return null;
	const classification = raw.github.review.classification;
	if (!isRecord(classification)) return null;
	const code = parsePatternSet(classification.code);
	const docs = parsePatternSet(classification.docs);
	const skills = parsePatternSet(classification.skills);
	const design = parsePatternSet(classification.design, true);
	return code === null || docs === null || skills === null || design === null ? null : {code, docs, skills, design};
};

/** Resolve a repository root without treating an arbitrary parent directory as policy authority. */
export const repositoryRoot = (cwd = process.cwd()): string | null => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null;
	} catch {
		return null;
	}
};

const sourceAtRef = (root: string, ref: string): string | null => {
	try {
		return execFileSync("git", ["show", `${ref}:${POLICY_PATH}`], {cwd: root, encoding: "utf8"});
	} catch {
		return null;
	}
};

const sourceInWorktree = (root: string): string | null => {
	const path = join(root, POLICY_PATH);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/**
 * Read policy from a requested Git ref for delivery decisions, or from the worktree for local
 * exploration. Any absence, parse failure, or schema failure resolves to the conservative policy.
 */
export const readClassificationPolicy = (root: string, policyRef: string | null): LoadedClassificationPolicy => {
	const source = policyRef === null ? sourceInWorktree(root) : sourceAtRef(root, policyRef);
	const location = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	if (source === null) return {policy: FAIL_CLOSED_POLICY, trusted: false, source: location, reason: "classification policy could not be read"};
	try {
		const policy = parseClassificationPolicy(JSON.parse(source) as unknown);
		return policy === null
			? {policy: FAIL_CLOSED_POLICY, trusted: false, source: location, reason: "classification policy has an unsupported shape"}
			: {policy, trusted: true, source: location, reason: null};
	} catch {
		return {policy: FAIL_CLOSED_POLICY, trusted: false, source: location, reason: "classification policy is not valid JSON"};
	}
};

/** A pull request's classification policy as each of its two sides states it. */
export type PullRequestPolicies = {
	readonly base: LoadedClassificationPolicy;
	readonly head: LoadedClassificationPolicy;
};

/**
 * Read both sides of a pull request's policy, each from its OWN ref.
 *
 * A policy read from the worktree is the policy of whichever checkout the caller happens to stand
 * in — for a PR that CHANGES the policy that is the side being replaced, so the PR is gated by the
 * rule it exists to retire (#120). Naming the two refs makes the question answerable: neither side
 * is implicit, and a caller in any checkout gets the same two policies for the same PR.
 *
 * `root` still comes from the caller's Git root, because resolving a ref needs a repository — but it
 * supplies only the object store now, never the policy content.
 */
export const readPullRequestPolicies = (
	root: string,
	baseRef: string,
	headRef: string,
): PullRequestPolicies => ({
	base: readClassificationPolicy(root, baseRef),
	head: readClassificationPolicy(root, headRef),
});
