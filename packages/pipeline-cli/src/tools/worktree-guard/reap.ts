/**
 * `worktree-guard` reap-decision core — pure decision for the
 * `SubagentStop` reaper that reclaims leaked agent worktrees (the originating work item).
 *
 * The load-bearing safety rule (MEMORY "Safe worktree prune", and the originating work item's AC): a
 * dirty/unpushed worktree must NEVER be force-removed. So this core maps a
 * finished worktree's clean/dirty status to a `git worktree remove` WITHOUT
 * `--force`: a CLEAN tree → `reap` (remove succeeds), a DIRTY tree → `refuse`
 * (the un-forced remove errors and the tree is KEPT, never silently discarded).
 *
 * `git worktree remove` (no `--force`) IS the enforcement: it refuses on a dirty
 * tree by design. The bin runs exactly that command, so even a misclassification
 * here can never discard unpushed work — the safety lives in the command, and the
 * decision here only chooses WHETHER to attempt it (and never adds `--force`).
 *
 * The OWNER gate (the originating work item): the reaper fires on `SubagentStop`, and `$WORKTREE_ROOT` is inherited
 * by every nested descendant. So a nested child's stop would reap its LIVE parent coder's worktree
 * unless we check ownership. No worktree-STATE signal distinguishes an owner-stop from a
 * nested-child-stop (both present identical clean/managed state, and cwd resets to primary between
 * calls) — the distinguishing fact lives in the SubagentStop PAYLOAD: the stopping agent's own
 * worktree (`ownedWorktree`, derived in the impure shell from the payload's transcript_path meta
 * sidecar). We reap only when the stopping agent OWNS `$WORKTREE_ROOT`; unprovable ownership ⇒ KEEP.
 */

import {isManagedWorktree} from "./arm.ts";

export type ReapDecision =
	| {readonly kind: "skip"; readonly reason: string}
	| {readonly kind: "reap"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

const normalizePath = (p: string): string => p.replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Decide whether to reap a finished subagent's worktree.
 *
 * - Empty root, or a root NOT under the managed `.claude/worktrees/` layout →
 *   **skip** (never reap an arbitrary path; the reaper only touches its own dir).
 * - The stopping agent does NOT own `$WORKTREE_ROOT` (a nested descendant that merely inherited the
 *   env var, or ownership unprovable from the payload) → **skip**: KEEP — never reap a live parent's
 *   worktree (the owner gate, the originating work item).
 * - A **dirty** owned tree → **refuse**: keep it, never `--force` (unpushed work is sacred).
 * - A **clean** owned tree → **reap**: `git worktree remove` (no `--force`) reclaims it.
 */
export const decideReap = (args: {
	readonly worktreeRoot: string;
	readonly ownedWorktree: string;
	readonly isDirty: boolean;
}): ReapDecision => {
	const {worktreeRoot, ownedWorktree, isDirty} = args;
	if (!worktreeRoot || !isManagedWorktree(worktreeRoot)) {
		return {kind: "skip", reason: "not a managed agent worktree; nothing to reap"};
	}
	if (!ownedWorktree || normalizePath(ownedWorktree) !== normalizePath(worktreeRoot)) {
		return {
			kind: "skip",
			reason:
				"stopping agent does not own $WORKTREE_ROOT (nested-descendant stop, or ownership unprovable from the payload); KEEP — never reap a live parent's worktree (#2798)",
		};
	}
	if (isDirty) {
		return {
			kind: "refuse",
			reason: "worktree is dirty/unpushed; KEPT (never --force, per the safe-worktree-prune rule)",
		};
	}
	return {
		kind: "reap",
		reason: "worktree is clean; reclaiming via `git worktree remove` (no --force)",
	};
};
