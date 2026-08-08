/**
 * `worktree-guard` arming core — decide WHETHER the guard has a worktree to guard, and say so
 * out loud either way (#141).
 *
 * Two defects with one shape. Every entry point keyed its worktree root on `$WORKTREE_ROOT`
 * alone, so a harness that provisions a genuine linked worktree without exporting that variable
 * left the root-keyed branch disarmed — and a disarmed guard emitted NOTHING, making "armed and
 * found nothing to refuse" byte-identical to "never armed at all" from outside. That silence is
 * the durable half of the bug: an env var a harness may omit is not a signal you can trust, and a
 * guard nobody can observe is a guard nobody can trust.
 *
 * So the root is RESOLVED from three signals, strongest first, and the outcome is REPORTED
 * whichever way it lands:
 *
 * 1. `$WORKTREE_ROOT` — authoritative when set, which keeps today's behaviour bit-for-bit.
 * 2. The running agent's own meta sidecar (`…/subagents/agent-<id>.meta.json`, reached from the
 *    hook payload's `transcript_path`), which records the worktree that agent OWNS. This is the
 *    signal that actually fixes #141: it is env-independent, and unlike cwd it survives the
 *    worktree-agent cwd reset.
 * 3. The payload cwd's own git worktree, when that cwd is a LINKED worktree under the managed
 *    layout. Last and weakest, because the cwd reset is the very hazard the guard exists for.
 *
 * A root that resolves from none of the three is DISARMED — reported with the reason, never a
 * silent return. Disarmed still means ALLOW (the orchestrator's own shell and a standalone human
 * run must keep working, per the standalone-path rule); the change is that it now says so.
 *
 * How often did provisioning omit the export? UNMEASURED, and unmeasurable backwards: a past run's
 * environment is recorded nowhere, so the rate cannot be reconstructed from anything on disk — the
 * one confirmed occurrence is the run that filed #141. What changes here is that it becomes
 * countable going forward, because every hook invocation now names the signal it armed from
 * (`source=env` vs `source=sidecar`/`source=git`) and an omission shows up as the latter.
 */

export type ArmSource = "env" | "sidecar" | "git";

export type GuardArm =
	| {readonly kind: "armed"; readonly root: string; readonly source: ArmSource}
	| {readonly kind: "disarmed"; readonly reason: string};

const WORKTREE_SEGMENT = "/.claude/worktrees/";

/** True when a path is a managed agent worktree (`<main>/.claude/worktrees/<id>`). */
export const isManagedWorktree = (worktreeRoot: string): boolean =>
	worktreeRoot.replace(/\\/g, "/").indexOf(WORKTREE_SEGMENT) > 0;

const DISARMED_NO_SIGNAL =
	`$WORKTREE_ROOT unset, the agent meta sidecar names no owned worktree, and the payload cwd is ` +
	`not a managed linked worktree — treating this as a primary-checkout or standalone run ` +
	`(allowing, per the standalone-path rule)`;

/**
 * Resolve the root the guard will act on from the three signals, in order of trust.
 *
 * A `$WORKTREE_ROOT` outside the managed layout disarms rather than arming — the same allow the
 * cores already produced for a bespoke root, except it is now stated instead of implied.
 */
export const resolveArm = (args: {
	readonly envRoot: string;
	readonly sidecarWorktree: string;
	readonly cwdWorktree: string;
}): GuardArm => {
	const envRoot = args.envRoot.trim();
	if (envRoot !== "") {
		return isManagedWorktree(envRoot)
			? {kind: "armed", root: envRoot, source: "env"}
			: {
					kind: "disarmed",
					reason: `$WORKTREE_ROOT=${envRoot} is not under the managed ${WORKTREE_SEGMENT} layout, so no main checkout is derivable from it`,
				};
	}
	const sidecarWorktree = args.sidecarWorktree.trim();
	if (isManagedWorktree(sidecarWorktree)) {
		return {kind: "armed", root: sidecarWorktree, source: "sidecar"};
	}
	const cwdWorktree = args.cwdWorktree.trim();
	if (isManagedWorktree(cwdWorktree)) return {kind: "armed", root: cwdWorktree, source: "git"};
	return {kind: "disarmed", reason: DISARMED_NO_SIGNAL};
};

/**
 * The one line every hook entry point emits on stderr before it decides, so armed-and-clean and
 * never-armed stop looking identical from outside. It also distinguishes a hook that ran from one
 * that never executed at all (#97's mis-quoted hook command emits no line whatsoever).
 */
export const formatArmStatus = (args: {
	readonly subcommand: string;
	readonly arm: GuardArm;
	readonly isolationExpected: boolean;
}): string => {
	const {subcommand, arm, isolationExpected} = args;
	if (arm.kind === "armed") {
		return `worktree-guard ${subcommand}: ARMED root=${arm.root} source=${arm.source}`;
	}
	const surviving = isolationExpected
		? " — isolation was EXPECTED for this run, so only the isolation-expected refusals (head-move, stage-all) apply"
		: "";
	return `worktree-guard ${subcommand}: NOT ARMED (isolation-expected=${
		isolationExpected ? "yes" : "no"
	}) — ${arm.reason}${surviving}`;
};
