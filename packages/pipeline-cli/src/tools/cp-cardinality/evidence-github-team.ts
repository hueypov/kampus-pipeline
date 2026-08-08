import {execFileSync} from "node:child_process";

const POLICY_PATH = ".pipeline/agent-policy.json";

/**
 * Where the approval roster comes from. `github-team` names an org team; `github-collaborators`
 * names the repository's own push-capable collaborators, the only authority a user-owned repo has.
 * The provider is stated, never inferred from an absent `teamSlug` — on a fail-closed gate a
 * dropped slug must refuse, not silently widen authority to everyone with push.
 */
export type ApprovalAuthorityProvider = "github-team" | "github-collaborators";

export type ProtectedChangeApprovalPolicy = {
	readonly authority: {
		readonly provider: ApprovalAuthorityProvider;
		readonly organization: string | null;
		readonly teamSlug: string | null;
	};
	readonly requiredNonAuthorApprovals: number;
	readonly soleAuthorException: {
		readonly enabled: boolean;
		readonly commentPattern: string | null;
	};
};

export type GithubTeamEvidenceFacts = {
	readonly members: ReadonlyArray<string>;
	readonly author: string;
	readonly requiredNonAuthorApprovals: number;
	readonly nonAuthorApprovalsAtHead: number;
	readonly soleAuthorExceptionAtHead: boolean;
};

export type EvidenceResolution =
	| {readonly ok: true; readonly facts: GithubTeamEvidenceFacts}
	| {readonly ok: false; readonly reason: string};

type JsonReader = (path: string, paginated: boolean) => unknown;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const nonBlankString = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

const isPositiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

const isSafeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value);

const asArrays = (value: unknown): ReadonlyArray<unknown> | null => {
	if (!Array.isArray(value)) return null;
	return value.every(Array.isArray) ? value.flat() : value;
};

/** Parse the complete additive policy section. Partial policy is never trusted. */
export const parseProtectedChangeApprovalPolicy = (raw: unknown): ProtectedChangeApprovalPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.shipping)) return null;
	const section = raw.github.shipping.protectedChangeApproval;
	if (!isRecord(section) || !isRecord(section.authority) || !isRecord(section.soleAuthorException)) return null;
	const authority = section.authority;
	const exception = section.soleAuthorException;
	const provider = authority.provider;
	if (
		(provider !== "github-team" && provider !== "github-collaborators") ||
		(authority.organization !== null && !nonBlankString(authority.organization)) ||
		(authority.teamSlug !== null && !nonBlankString(authority.teamSlug)) ||
		!isPositiveInteger(section.requiredNonAuthorApprovals) ||
		typeof exception.enabled !== "boolean" ||
		(exception.commentPattern !== null && !nonBlankString(exception.commentPattern))
	) return null;
	// A collaborator authority carrying org/team coordinates is a half-done migration — it would
	// read as one authority while being configured for another, so it is malformed, not merely
	// unconfigured. A team authority with a null slug stays parseable on purpose: that is the
	// shipped default meaning "no authority declared yet", and it fails closed at resolve with a
	// diagnostic that says so rather than calling an untouched default unsafe.
	if (provider === "github-collaborators" && (authority.teamSlug !== null || authority.organization !== null)) return null;
	if (exception.enabled) {
		if (exception.commentPattern === null) return null;
		try { new RegExp(exception.commentPattern); } catch { return null; }
	} else if (exception.commentPattern !== null) return null;
	return {
		authority: {
			provider,
			organization: authority.organization === null ? null : authority.organization.trim(),
			teamSlug: authority.teamSlug === null ? null : authority.teamSlug.trim(),
		},
		requiredNonAuthorApprovals: section.requiredNonAuthorApprovals,
		soleAuthorException: {enabled: exception.enabled, commentPattern: exception.commentPattern},
	};
};

/** Read exactly the named immutable ref. A failed base-policy read never falls back to the PR or worktree. */
export const readProtectedChangeApprovalPolicy = (
	root: string,
	policyRef: string,
): {readonly policy: ProtectedChangeApprovalPolicy | null; readonly source: string; readonly reason: string | null} => {
	const source = `${policyRef}:${POLICY_PATH}`;
	let contents: string;
	try {
		contents = execFileSync("git", ["show", source], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
	} catch {
		return {policy: null, source, reason: "protected-change approval policy could not be read from the immutable policy ref"};
	}
	try {
		const policy = parseProtectedChangeApprovalPolicy(JSON.parse(contents) as unknown);
		return policy === null
			? {policy: null, source, reason: "protected-change approval policy has an unsupported or unsafe shape"}
			: {policy, source, reason: null};
	} catch {
		return {policy: null, source, reason: "protected-change approval policy is not valid JSON"};
	}
};

const uniqueIdentities = (entries: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(entries.map((entry) => entry.trim()))];

/**
 * `pushCapableOnly` applies to the collaborator roster: a read- or triage-only collaborator is
 * listed by the API but is not approval authority. An entry whose permissions cannot be read is
 * UNKNOWN, so the whole roster fails rather than silently dropping a member.
 */
const parseMembers = (raw: unknown, pushCapableOnly: boolean): ReadonlyArray<string> | null => {
	const entries = asArrays(raw);
	if (entries === null) return null;
	const members: string[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || !nonBlankString(entry.login)) return null;
		if (pushCapableOnly) {
			const permissions = entry.permissions;
			if (!isRecord(permissions) || typeof permissions.push !== "boolean") return null;
			if (!permissions.push) continue;
		}
		members.push(entry.login);
	}
	return uniqueIdentities(members);
};

const parsePull = (raw: unknown): {readonly author: string; readonly head: string} | null => {
	if (!isRecord(raw) || !isRecord(raw.user) || !nonBlankString(raw.user.login) || !isRecord(raw.head) || !nonBlankString(raw.head.sha)) return null;
	return {author: raw.user.login.trim(), head: raw.head.sha.trim()};
};

type Review = {readonly id: number; readonly author: string; readonly state: string; readonly commit: string | null};

const parseReviews = (raw: unknown): ReadonlyArray<Review> | null => {
	const entries = asArrays(raw);
	if (entries === null) return null;
	const reviews: Review[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || !isSafeInteger(entry.id) || !isRecord(entry.user) || !nonBlankString(entry.user.login) || typeof entry.state !== "string" || (entry.commit_id !== null && !nonBlankString(entry.commit_id))) return null;
		reviews.push({id: entry.id, author: entry.user.login.trim(), state: entry.state, commit: entry.commit_id === null ? null : entry.commit_id.trim()});
	}
	return reviews;
};

type Comment = {readonly author: string; readonly body: string};

const parseComments = (raw: unknown): ReadonlyArray<Comment> | null => {
	const entries = asArrays(raw);
	if (entries === null) return null;
	const comments: Comment[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || !isRecord(entry.user) || !nonBlankString(entry.user.login) || typeof entry.body !== "string") return null;
		comments.push({author: entry.user.login.trim(), body: entry.body});
	}
	return comments;
};

const repositoryParts = (repo: string): {readonly owner: string; readonly name: string} | null => {
	const parts = repo.trim().split("/");
	return parts.length === 2 && nonBlankString(parts[0]) && nonBlankString(parts[1]) && !/\s/.test(repo)
		? {owner: parts[0], name: parts[1]}
		: null;
};

/**
 * Resolve provider evidence into the exact JSON facts consumed by `decide`. Any malformed
 * provider data is UNKNOWN, represented by a failed result rather than an empty roster/count.
 */
export const resolveGithubTeamEvidence = (
	policy: ProtectedChangeApprovalPolicy,
	repo: string,
	pr: number,
	readJson: JsonReader,
): EvidenceResolution => {
	if (!Number.isSafeInteger(pr) || pr < 1) return {ok: false, reason: "pull request number must be a positive integer"};
	const parsedRepo = repositoryParts(repo);
	const {provider, teamSlug} = policy.authority;
	// `parse` already rejects a slugless team authority; re-assert it here so a hand-built policy
	// can never fall through to a wider roster than the one it names.
	if (parsedRepo === null || (provider === "github-team" && teamSlug === null)) return {ok: false, reason: "repository or configured approval authority is incomplete"};
	const collaboratorAuthority = provider === "github-collaborators";
	const organization = policy.authority.organization ?? parsedRepo.owner;
	let membersRaw: unknown;
	let pullRaw: unknown;
	let reviewsRaw: unknown;
	let commentsRaw: unknown;
	try {
		membersRaw = collaboratorAuthority
			? readJson(`repos/${repo}/collaborators?per_page=100`, true)
			: readJson(`orgs/${encodeURIComponent(organization)}/teams/${encodeURIComponent(teamSlug as string)}/members?per_page=100`, true);
		pullRaw = readJson(`repos/${repo}/pulls/${pr}`, false);
		reviewsRaw = readJson(`repos/${repo}/pulls/${pr}/reviews?per_page=100`, true);
		commentsRaw = policy.soleAuthorException.enabled ? readJson(`repos/${repo}/issues/${pr}/comments?per_page=100`, true) : [];
	} catch {
		return {ok: false, reason: "GitHub REST evidence could not be read"};
	}
	const members = parseMembers(membersRaw, collaboratorAuthority);
	const pull = parsePull(pullRaw);
	const reviews = parseReviews(reviewsRaw);
	const comments = parseComments(commentsRaw);
	if (members === null || pull === null || reviews === null || comments === null) return {ok: false, reason: "GitHub REST evidence has an unreadable or invalid shape"};

	const latestByReviewer = new Map<string, Review>();
	for (const review of reviews) {
		const prior = latestByReviewer.get(review.author);
		if (prior === undefined || review.id > prior.id) latestByReviewer.set(review.author, review);
	}
	const memberSet = new Set(members);
	const approvals = [...latestByReviewer.values()].filter((review) =>
		review.author !== pull.author && memberSet.has(review.author) && review.state === "APPROVED" && review.commit === pull.head,
	).length;
	const exception = policy.soleAuthorException.enabled
		? comments.some((comment) =>
			comment.author === pull.author &&
			new RegExp(policy.soleAuthorException.commentPattern as string).test(comment.body) &&
			comment.body.includes(pull.head),
		)
		: false;
	return {
		ok: true,
		facts: {
			members,
			author: pull.author,
			requiredNonAuthorApprovals: policy.requiredNonAuthorApprovals,
			nonAuthorApprovalsAtHead: approvals,
			soleAuthorExceptionAtHead: exception,
		},
	};
};

/** Execute `gh api` REST only; `--slurp` makes each paginated response one JSON document. */
export const ghRestJson = (path: string, paginated: boolean): unknown => {
	const args = paginated ? ["api", path, "--paginate", "--slurp"] : ["api", path];
	return JSON.parse(execFileSync("gh", args, {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]})) as unknown;
};
