import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

export type LifecyclePolicy = {
	readonly git: {
		readonly primaryBranch: string | null;
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
		const postSyncCommand = git.postSyncCommand;
		const managedRoots = strings(worktrees.managedRoots);
		const reviewPrefixes = strings(worktrees.reviewPrefixes);
		const idleMinutes = worktrees.idleMinutes;
		const maxChangedLines = trivialDiff.maxChangedLines;
		const protectedPaths = strings(trivialDiff.protectedPaths);
		if (
			(primaryBranch !== null && (typeof primaryBranch !== "string" || !primaryBranch.trim())) ||
			(postSyncCommand !== null && strings(postSyncCommand) === null) ||
			managedRoots === null || reviewPrefixes === null ||
			!Number.isInteger(idleMinutes) || (idleMinutes as number) < 0 ||
			typeof trivialDiff.enabled !== "boolean" || !Number.isInteger(maxChangedLines) ||
			(maxChangedLines as number) < 0 || protectedPaths === null
		) return null;
		return {
			git: {primaryBranch: primaryBranch as string | null, postSyncCommand: postSyncCommand as ReadonlyArray<string> | null},
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
