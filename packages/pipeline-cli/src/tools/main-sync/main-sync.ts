/**
 * `main-sync` pure core — decide how the orchestrator should sync the shared primary
 * checkout to `origin/main`. IO-free and total: a deterministic transform over
 * already-gathered git facts; the git boundary (probes / fetch / checkout / merge)
 * lives in `command.ts`. See the originating work item (drain-sync reattach), the originating work item (post-merge refresh),
 * the related failure modes (mass-deletion refusal).
 *
 * The load-bearing safety policy, in order:
 *  - A `the originating work item` mass control-plane staged deletion is refused BY NAME, first, in both
 *    decide functions — a guaranteed LOUD refusal keyed on the same signature §CP
 *    `primary-index-guard` blocks, not the incidental dirt-probe side-effect it was (the originating work item).
 *  - The drain-sync reattach (`decideMainSync`) moves HEAD, so it is authorized ONLY on a
 *    clean tree; a dirty tree detects-and-surfaces rather than discarding operator work.
 *  - The post-merge refresh (`decideMainRefresh`) NEVER moves HEAD: off-`main` or
 *    tracked-modified → leave-alone; it ff's through untracked-only dirt (the originating work item).
 */

/**
 * The primary checkout's HEAD state, reduced to the facts the decision needs. Gathered
 * at the git boundary; every field fail-safes toward refusing to mutate (an
 * indeterminate probe reads detached / dirty).
 */
export interface HeadState {
	/** Short branch name, or `null` for a detached HEAD. `"main"` is the healthy state. */
	readonly branch: string | null;
	/**
	 * Working tree has any uncommitted/untracked changes. The coarse signal the drain-sync
	 * reattach gates on; the refresh gates on the finer `hasTrackedModifications` (the originating work item).
	 */
	readonly isDirty: boolean;
	/**
	 * Staged/unstaged changes to TRACKED files, excluding untracked — the only dirt a
	 * `merge --ff-only` could clobber (it ff's straight through untracked files). Implies
	 * `isDirty`. The post-merge refresh gates on this, not `isDirty` (the originating work item).
	 */
	readonly hasTrackedModifications: boolean;
	/**
	 * Count of staged deletions under the instruction-trust prefixes (`.claude/**`,
	 * `.decisions/**`, …) — the documented failure signature, classified at the git boundary. Reading
	 * its own value is what makes the catch a guarantee, not an incidental side-effect (the originating work item).
	 */
	readonly stagedControlPlaneDeletionCount: number;
}

/** The name of the branch the primary checkout must be attached to for a clean main-sync. */
export const MAIN_BRANCH = "main";

// Re-exported single source: main-sync refuses at the SAME threshold §CP
// `primary-index-guard` blocks at, so sync-path refusal and pre-commit block agree.
export {MASS_DELETION_BLOCK_THRESHOLD} from "../primary-index-guard/tripwire.ts";

import {MASS_DELETION_BLOCK_THRESHOLD} from "../primary-index-guard/tripwire.ts";

/** True when the primary index carries a #2778 mass control-plane staged deletion (at/above the block threshold). */
export const isMassControlPlaneDeletion = (head: HeadState): boolean =>
	head.stagedControlPlaneDeletionCount >= MASS_DELETION_BLOCK_THRESHOLD;

/**
 * What the orchestrator should do to reach a state where `merge --ff-only origin/main`
 * can run. The order of the checks below IS the safety policy (see module docblock).
 */
export type MainSyncPlan =
	// the originating work item mass staged deletion — refused by name, before any other check (the originating work item).
	| {readonly action: "blocked-mass-deletion"; readonly count: number}
	// Already on `main` — sync proceeds straight to fetch + merge --ff-only.
	| {readonly action: "already-on-main"; readonly branch: string}
	// Off-`main` AND clean — the documented failure recoverable case; reattach is authorized.
	| {readonly action: "reattach"; readonly from: string}
	// Off-`main` BUT dirty — detect-and-surface; refuse to reattach, never discard work.
	| {readonly action: "blocked-dirty"; readonly from: string};

// Stable label so a detached HEAD (`branch === null`) reports as "detached-HEAD", not "".
export const DETACHED_LABEL = "detached-HEAD";

const fromLabel = (branch: string | null): string => branch ?? DETACHED_LABEL;

/**
 * Decide the drain-sync plan. Total over every `HeadState`; the dirty check is consulted
 * ONLY on the off-`main` path, so a clean detached HEAD reattaches and a dirty one is
 * surfaced, never checked out. See the module docblock for the ordering rationale.
 */
export const decideMainSync = (head: HeadState): MainSyncPlan => {
	if (isMassControlPlaneDeletion(head)) {
		return {action: "blocked-mass-deletion", count: head.stagedControlPlaneDeletionCount};
	}
	if (head.branch === MAIN_BRANCH) {
		return {action: "already-on-main", branch: MAIN_BRANCH};
	}
	if (head.isDirty) {
		return {action: "blocked-dirty", from: fromLabel(head.branch)};
	}
	return {action: "reattach", from: fromLabel(head.branch)};
};

/**
 * What the post-merge refresh should do — the HEAD-preserving counterpart to
 * `MainSyncPlan` (the originating work item). Either a fast-forward is safe, or the checkout is left as-is;
 * the refresh never moves HEAD.
 */
export type MainRefreshPlan =
	// the originating work item mass staged deletion — a LOUD fail-closed refusal (exits non-zero), NOT the
	// silent `leave-alone` no-op; the loaded-gun state must surface (the originating work item).
	| {readonly action: "refuse-mass-deletion"; readonly count: number}
	// On `main`, no tracked modifications — ff is safe (passes through untracked-only dirt, the originating work item).
	| {readonly action: "fast-forward"; readonly branch: string}
	// Deliberate no-op: off-`main` (ff can't advance a feature branch) or tracked-modified
	// (ff could clobber). `reason` `dirty` means tracked-modified (the originating work item).
	| {
			readonly action: "leave-alone";
			readonly reason: "off-main" | "dirty";
			readonly branch: string;
	  };

/**
 * Decide the post-merge refresh plan (the originating work item). Total over every `HeadState`. The branch
 * check precedes the tracked-dirt check on purpose: off-`main` is the binding reason the ff
 * can't run regardless of tree state, so it is reported even when also dirty.
 *
 * The ff-blocking guard consults `hasTrackedModifications`, NOT `isDirty` (the originating work item): a ff passes
 * straight through untracked files, so gating on `isDirty` bought no safety and pinned the
 * primary stale session-long (the documented failure detached-HEAD corruption root cause).
 */
export const decideMainRefresh = (head: HeadState): MainRefreshPlan => {
	if (isMassControlPlaneDeletion(head)) {
		return {action: "refuse-mass-deletion", count: head.stagedControlPlaneDeletionCount};
	}
	if (head.branch !== MAIN_BRANCH) {
		return {action: "leave-alone", reason: "off-main", branch: fromLabel(head.branch)};
	}
	if (head.hasTrackedModifications) {
		return {action: "leave-alone", reason: "dirty", branch: MAIN_BRANCH};
	}
	return {action: "fast-forward", branch: MAIN_BRANCH};
};
