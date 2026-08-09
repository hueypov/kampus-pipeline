import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {readLifecyclePolicy} from "../lifecycle-policy.ts";
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
		// The child's stderr is discarded rather than inherited. Every failure here is HANDLED — it
		// becomes the untrusted fail-closed load below — and letting git's `fatal: path … exists on
		// disk, but not in <sha>` reach the caller's stream makes a decision this code took on purpose
		// read like a crash. It leaked into this repository's own test log that way.
		return execFileSync("git", ["show", `${ref}:${POLICY_PATH}`], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
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

/** Can this repository already resolve `ref` to a commit, with no network? */
const commitPresent = (root: string, ref: string): boolean => {
	try {
		execFileSync("git", ["cat-file", "-e", `${ref}^{commit}`], {cwd: root, stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
};

/**
 * Bring one commit into the local object store.
 *
 * Fetching a bare SHA writes objects and `FETCH_HEAD` — no branch, no index, no HEAD — so it cannot
 * disturb the checkout the caller is standing in. Each ref is fetched on its own: one command for
 * both would fail wholesale when only one is missing, discarding a fetch that did succeed.
 */
const fetchCommit = (root: string, remote: string, ref: string): void => {
	try {
		execFileSync("git", ["fetch", "--no-tags", "--quiet", remote, ref], {cwd: root, stdio: "ignore"});
	} catch {
		// Unreachable object, no network, no permission — all one fact to the caller, established by
		// re-probing the object store rather than by reading this failure.
	}
};

const gitValue = (root: string, args: ReadonlyArray<string>): string | null => {
	try {
		return execFileSync("git", [...args], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim() || null;
	} catch {
		return null;
	}
};

/**
 * Which remote can supply a commit this repository does not have.
 *
 * Deliberately NOT `resolvePrimaryTarget`. That answers a different question — which branch is
 * primary and where does it live — and it yields no remote whenever no default branch can be
 * determined, which is true of every `--single-branch` clone. That is precisely the checkout this
 * fetch exists for, so asking it here reported "no remote to fetch from" in a clone that plainly had
 * one. Fetching an object needs somewhere to fetch FROM, not a branch policy.
 *
 * The configured primary remote still wins where a repository names one, so this adds no implicit
 * `origin` policy to a repository that has stated its own.
 */
const objectRemote = (root: string): string | null => {
	const configured = readLifecyclePolicy(root)?.git.primaryRemote ?? null;
	if (configured !== null) return configured;
	const names = (gitValue(root, ["remote"]) ?? "").split("\n").map((n) => n.trim()).filter(Boolean);
	if (names.length === 0) return null;
	const branch = gitValue(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const upstream = branch === null ? null : gitValue(root, ["config", "--get", `branch.${branch}.remote`]);
	if (upstream !== null && upstream !== "." && names.includes(upstream)) return upstream;
	if (names.includes("origin")) return "origin";
	return names.length === 1 ? (names[0] as string) : null;
};

/** Both policies, or the refs that could not be made resolvable and the remote that was tried. */
export type PullRequestPolicyResolution =
	| {readonly _tag: "resolved"; readonly policies: PullRequestPolicies}
	| {
			readonly _tag: "unresolved";
			readonly refs: ReadonlyArray<string>;
			readonly remote: string | null;
	  };

/**
 * Resolve both sides of a pull request's policy, fetching whichever commit is not local yet.
 *
 * `readPullRequestPolicies` alone assumes both commits are already in the object store, and a caller
 * that has not fetched since the author's last push does not have the head — which is the ordinary
 * state, not an exotic one: `--single-branch` and shallow clones, `actions/checkout` with
 * `fetch-depth: 1`, and every cross-fork PR start there. Left unfetched, each absent ref loads as the
 * untrusted classify-everything policy, the union demands every namespace including one this
 * repository's policy configures with no include pattern at all, and the merge gate asks for a
 * verdict nothing can ever route.
 *
 * The fetch lives here rather than in each caller because the sibling consumer proved prose does not
 * hold it: `templates/github/workflows/pipeline-delivery-gate.yml` fetches the base SHA before
 * classifying, and the merge gate — added later, reading the same refs — did not. See ADR 0002.
 *
 * A ref still unresolvable after the fetch is **unresolved**, never a fail-closed policy: not knowing
 * what the rules are is a different fact from knowing they are strict, and only the caller can say
 * which of its two failure directions that fact belongs in.
 */
export const resolvePullRequestPolicies = (
	root: string,
	baseRef: string,
	headRef: string,
	remote: string | null = objectRemote(root),
): PullRequestPolicyResolution => {
	const missing = [...new Set([baseRef, headRef])].filter((ref) => !commitPresent(root, ref));
	if (remote !== null) for (const ref of missing) fetchCommit(root, remote, ref);
	const unresolved = missing.filter((ref) => !commitPresent(root, ref));
	return unresolved.length > 0
		? {_tag: "unresolved", refs: unresolved, remote}
		: {_tag: "resolved", policies: readPullRequestPolicies(root, baseRef, headRef)};
};
