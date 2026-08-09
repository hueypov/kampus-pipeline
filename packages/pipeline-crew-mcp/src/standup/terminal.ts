/**
 * standup/terminal — the terminal-backend seam: ONE interface over the handful of window-manager
 * operations the launcher actually needs, with a tmux and a herdr implementation behind it.
 *
 * The launcher's coupling to a multiplexer is deliberately narrow. It coordinates the crew over the
 * channels substrate; a multiplexer only ever puts panes on the operator's screen. That whole surface
 * is five operations — resolve the host, open the crew window, split into it, find it again, and find
 * and close one member's pane — so a second backend is an implementation of those five, never a second
 * launch path. Every derivation upstream of them (roster, binds, placements, project scope, the
 * no-partial-crew ordering) is backend-agnostic and stays in `orchestrate.ts` / `single-role.ts`.
 *
 * The one non-obvious thing: this module is the ONLY place that knows both backends, and nothing in
 * `standup/` imports it. Selection happens at the composition root (`bin.ts`), which reads the
 * operator config's `terminal` dimension (or the `--terminal` override) and injects the chosen
 * backend's operations through the injection points `runStandUp` / `spawnRole` / `retireRole` already
 * expose for testing. That keeps the dependency edges one-way — `terminal → {orchestrate, single-role,
 * herdr} → config` — so adding a backend never introduces an import cycle, and the launcher core
 * cannot grow a `switch (terminal)` in it.
 *
 * A crew is stood up, split, and retired under ONE backend. The operations are not interchangeable
 * mid-flight (a tmux pane id means nothing to herdr), so switching backends means standing the crew
 * down and back up — which is why the dimension is read once per command, not per pane.
 */
import {Effect} from "effect";
import {DEFAULT_TERMINAL, type TerminalKind} from "./config.ts";
import {
	closeHerdrPane,
	findCrewPaneIdInHerdr,
	launchSessionInHerdr,
	resolveCrewTabId,
	resolveTargetHerdrWorkspace,
	runHerdr,
} from "./herdr.ts";
import {
	FALLBACK_TMUX_SESSION,
	type LaunchedSession,
	type LaunchPlan,
	launchSessionInTmux,
	resolveTargetTmuxSession,
	runTmux,
	type StandUpLaunchError,
	type TmuxSessionEnsureError,
} from "./orchestrate.ts";
import {
	CrewPaneKillError,
	type CrewPaneNotFoundError,
	type CrewWindowNotRunningError,
	findCrewPaneId,
	resolveCrewWindowId,
} from "./single-role.ts";

export {DEFAULT_TERMINAL, TerminalKind} from "./config.ts";

/**
 * The window-manager operations the launcher drives, in the vocabulary of the tmux path that defined
 * them. "Window" is tmux's window / herdr's tab; "session" is tmux's session / herdr's workspace. The
 * names stay tmux-flavoured on purpose — they are the contract the existing launcher already speaks,
 * and renaming them would churn every call site to describe the same five operations.
 */
export interface TerminalBackend {
	/** Which backend this is — carried so a command can name it in its operator-facing output. */
	readonly kind: TerminalKind;
	/** Resolve the host the crew window opens under: the caller's current session/workspace, else a created fallback. */
	readonly resolveTargetSession: () => Effect.Effect<string, TmuxSessionEnsureError>;
	/**
	 * Launch one planned session as a pane of the crew window under `targetSession`. The first session
	 * (`intoWindow` undefined) opens the crew window and returns its id; every later session splits into
	 * that id. Only ever returns for a pane confirmed live — the no-partial-crew contract.
	 *
	 * `crewSize` is how many panes the finished window holds, and it is a HINT, not a dimension of the
	 * contract: a backend that re-tiles after every split (tmux's `select-layout tiled`) ignores it, and
	 * one that has to compute the even share up front (herdr) places better with it. `spawn-role` adds a
	 * pane to a window whose final size nobody knows and passes nothing.
	 */
	readonly launch: (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
		crewSize?: number,
	) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
	/** Resolve the id of the RUNNING crew window in `targetSession`, for `spawn-role` to split into. Fails closed if no crew is up. */
	readonly resolveCrewWindow: (
		targetSession: string,
	) => Effect.Effect<string, CrewWindowNotRunningError>;
	/**
	 * Find the ONE running pane for a member. Both identities the launcher stamped are passed because the
	 * backends key on different ones — tmux matches the launch `--name` (`displayName`), herdr matches the
	 * member's distinct launch cwd (`cwdLabel`) — and neither can derive the other's.
	 */
	readonly findCrewPane: (
		cwdLabel: string,
		displayName: string,
	) => Effect.Effect<string, CrewPaneNotFoundError>;
	/** Close one member's pane. Fails closed rather than leaving a half-torn-down member. */
	readonly closePane: (paneId: string) => Effect.Effect<void, CrewPaneKillError>;
}

/**
 * The tmux backend — the launcher's original and default path, gathered here unchanged. Every operation
 * delegates to the function that already implemented it, so selecting tmux is byte-for-byte the
 * behaviour every existing install already has.
 */
export const tmuxBackend: TerminalBackend = {
	kind: "tmux",
	resolveTargetSession: () =>
		resolveTargetTmuxSession(
			{inTmux: process.env.TMUX !== undefined, fallbackSession: FALLBACK_TMUX_SESSION},
			runTmux,
		),
	launch: (plan, targetSession, intoWindow) => launchSessionInTmux(plan, targetSession, intoWindow),
	resolveCrewWindow: (targetSession) => resolveCrewWindowId(targetSession, runTmux),
	findCrewPane: (_cwdLabel, displayName) => findCrewPaneId(displayName, runTmux),
	closePane: (paneId) =>
		Effect.gen(function* () {
			const killed = yield* runTmux(["kill-pane", "-t", paneId]);
			if (killed.spawnError !== undefined || killed.code !== 0) {
				return yield* Effect.fail(
					new CrewPaneKillError({
						paneId,
						reason:
							killed.spawnError ??
							`tmux kill-pane -t ${paneId} exited ${killed.code ?? killed.signal}`,
					}),
				);
			}
		}),
};

/** The herdr backend — the same five operations over herdr's socket API (see `herdr.ts` for the two-step launch shape). */
export const herdrBackend: TerminalBackend = {
	kind: "herdr",
	resolveTargetSession: () => resolveTargetHerdrWorkspace(),
	launch: (plan, targetSession, intoWindow, crewSize) =>
		launchSessionInHerdr(plan, targetSession, intoWindow, runHerdr, crewSize),
	resolveCrewWindow: (targetSession) => resolveCrewTabId(targetSession),
	findCrewPane: (cwdLabel, displayName) => findCrewPaneIdInHerdr(cwdLabel, displayName),
	closePane: (paneId) => closeHerdrPane(paneId),
};

/** Every backend an operator can select, keyed by the `terminal` config value that names it. */
export const TERMINAL_BACKENDS: Readonly<Record<TerminalKind, TerminalBackend>> = {
	tmux: tmuxBackend,
	herdr: herdrBackend,
};

/**
 * Resolve the backend for a selected kind. Total over `TerminalKind` — the schema already rejected any
 * other value at config-decode time, so there is no unknown-backend failure mode to handle here.
 */
export const terminalBackend = (kind: TerminalKind = DEFAULT_TERMINAL): TerminalBackend =>
	TERMINAL_BACKENDS[kind];
