import {basename, resolve} from "node:path";

export type WorktreeRecord = {
	readonly path: string;
	readonly branch: string | null;
	readonly prunable: boolean;
	readonly dirty: boolean;
	readonly locked: boolean;
	readonly recentlyActive: boolean;
	readonly integrated: boolean;
	readonly hasOpenPr: boolean;
};

export type SweepDecision = {readonly kind: "keep" | "remove"; readonly reason: string};

export const isManagedRoot = (path: string, roots: ReadonlyArray<string>): boolean => {
	const candidate = resolve(path);
	return roots.some((root) => {
		const resolved = resolve(root);
		return candidate === resolved || candidate.startsWith(`${resolved}/`);
	});
};

export const isReviewWorktree = (path: string, prefixes: ReadonlyArray<string>): boolean =>
	prefixes.some((prefix) => basename(path).startsWith(prefix));

/**
 * The sweep decision has no destructive side effect. An uncertain fact is represented as a
 * conservative true value by the Git boundary, so this core can only choose REMOVE after every
 * ownership, liveness, and integration condition has been proved.
 */
export const decideSweep = (record: WorktreeRecord, inScope: boolean, reviewWorktree: boolean): SweepDecision => {
	if (!inScope && !reviewWorktree) return {kind: "keep", reason: "not-managed"};
	if (record.prunable) return {kind: "remove", reason: "gone-directory-metadata"};
	if (record.dirty) return {kind: "keep", reason: "dirty"};
	if (record.locked) return {kind: "keep", reason: "locked"};
	if (record.recentlyActive) return {kind: "keep", reason: "recently-active"};
	if (reviewWorktree) return {kind: "remove", reason: "idle-review-worktree"};
	if (record.hasOpenPr) return {kind: "keep", reason: "open-pull-request"};
	if (!record.integrated) return {kind: "keep", reason: "not-proved-integrated"};
	return {kind: "remove", reason: "clean-integrated-idle-worktree"};
};

/** The only removal invocation the command may issue; force removal is deliberately absent. */
export const safeRemoveArgs = (path: string): ReadonlyArray<string> => ["worktree", "remove", path];
