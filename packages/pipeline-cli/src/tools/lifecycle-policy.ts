import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

export type LifecyclePolicy = {
	readonly git: {
		readonly primaryBranch: string | null;
		readonly primaryRemote: string | null;
		readonly postSyncCommand: ReadonlyArray<string> | null;
	};
	readonly worktrees: {
		readonly managedRoots: ReadonlyArray<string>;
		readonly reviewPrefixes: ReadonlyArray<string>;
		readonly idleMinutes: number;
	};
	readonly trivialDiff: {
		readonly enabled: boolean;
		readonly maxChangedLines: number;
		readonly protectedPaths: ReadonlyArray<string>;
	};
};

export type PrimaryTarget = {
	readonly branch: string | null;
	readonly remote: string | null;
	readonly reason: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): ReadonlyArray<string> | null =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
		? value
		: null;

/** Resolve the repository root without guessing when this command is run outside Git. */
export const repositoryRoot = (cwd = process.cwd()): string | null => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null;
	} catch {
		return null;
	}
};

/**
 * Read only the portable lifecycle settings. A malformed or absent policy is null, so callers
 * can choose the conservative outcome appropriate to their operation (refuse, keep, or classify
 * non-trivial); no caller receives a partially trusted policy object.
 */
export const readLifecyclePolicy = (root: string): LifecyclePolicy | null => {
	const path = join(root, ".pipeline/agent-policy.json");
	if (!existsSync(path)) return null;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github)) return null;
		const git = raw.git;
		const worktrees = raw.worktrees;
		const review = raw.github.review;
		const trivialDiff = isRecord(review) ? review.trivialDiff : undefined;
		if (!isRecord(git) || !isRecord(worktrees) || !isRecord(trivialDiff)) return null;
		const primaryBranch = git.primaryBranch;
		const primaryRemote = git.primaryRemote;
		const postSyncCommand = git.postSyncCommand;
		const managedRoots = strings(worktrees.managedRoots);
		const reviewPrefixes = strings(worktrees.reviewPrefixes);
		const idleMinutes = worktrees.idleMinutes;
		const maxChangedLines = trivialDiff.maxChangedLines;
		const protectedPaths = strings(trivialDiff.protectedPaths);
		if (
			(primaryBranch !== null && (typeof primaryBranch !== "string" || !primaryBranch.trim())) ||
			(primaryRemote !== null && (typeof primaryRemote !== "string" || !primaryRemote.trim())) ||
			(postSyncCommand !== null && strings(postSyncCommand) === null) ||
			managedRoots === null || reviewPrefixes === null ||
			!Number.isInteger(idleMinutes) || (idleMinutes as number) < 0 ||
			typeof trivialDiff.enabled !== "boolean" || !Number.isInteger(maxChangedLines) ||
			(maxChangedLines as number) < 0 || protectedPaths === null
		) return null;
		return {
			git: {
				primaryBranch: primaryBranch as string | null,
				primaryRemote: primaryRemote as string | null,
				postSyncCommand: postSyncCommand as ReadonlyArray<string> | null,
			},
			worktrees: {managedRoots, reviewPrefixes, idleMinutes: idleMinutes as number},
			trivialDiff: {enabled: trivialDiff.enabled, maxChangedLines: maxChangedLines as number, protectedPaths},
		};
	} catch {
		return null;
	}
};

/** Resolve a remote's declared default branch, rather than assuming a branch called `main`. */
export const remotePrimaryBranch = (root: string): string | null => {
	try {
		const ref = execFileSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
			cwd: root,
			encoding: "utf8",
		}).trim();
		return ref.startsWith("origin/") && ref.length > "origin/".length ? ref.slice("origin/".length) : null;
	} catch {
		return null;
	}
};

const gitValue = (root: string, args: ReadonlyArray<string>): string | null => {
	try {
		const value = execFileSync("git", [...args], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
		return value === "" ? null : value;
	} catch {
		return null;
	}
};

const remoteDefault = (root: string, remote: string): string | null => {
	const ref = gitValue(root, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`]);
	const prefix = `${remote}/`;
	return ref?.startsWith(prefix) && ref.length > prefix.length ? ref.slice(prefix.length) : null;
};

const branchUpstreamRemote = (root: string, branch: string): string | null => {
	const remote = gitValue(root, ["config", "--get", `branch.${branch}.remote`]);
	return remote === null || remote === "." ? null : remote;
};

/**
 * Resolve the repository's primary branch without an implicit `main`/`origin` policy.
 * A branch can be known without a comparison remote: the ref guard still refuses deleting
 * that branch, while a missing remote-tracking ref retains the fresh-clone allow behavior.
 */
export const resolvePrimaryTarget = (root: string, policy: LifecyclePolicy | null = readLifecyclePolicy(root)): PrimaryTarget => {
	const configuredBranch = policy?.git.primaryBranch ?? null;
	const configuredRemote = policy?.git.primaryRemote ?? null;
	if (configuredBranch !== null) {
		const remote = configuredRemote ?? branchUpstreamRemote(root, configuredBranch);
		return {branch: configuredBranch, remote, reason: "configured primary branch"};
	}
	if (configuredRemote !== null) {
		const branch = remoteDefault(root, configuredRemote);
		return {branch, remote: configuredRemote, reason: branch === null ? "configured remote has no declared default branch" : "configured remote default branch"};
	}
	const remotes = (gitValue(root, ["remote"]) ?? "").split("\n").map((value) => value.trim()).filter(Boolean);
	const candidates = remotes.flatMap((remote) => {
		const branch = remoteDefault(root, remote);
		return branch === null ? [] : [{remote, branch}];
	});
	if (candidates.length === 1) {
		const candidate = candidates[0] as {readonly remote: string; readonly branch: string};
		return {branch: candidate.branch, remote: candidate.remote, reason: "unique discovered remote default branch"};
	}
	return {branch: null, remote: null, reason: candidates.length === 0 ? "no configured or discoverable remote default branch" : "multiple remote defaults are ambiguous"};
};
