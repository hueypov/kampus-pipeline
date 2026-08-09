/**
 * standup/orchestrate — the one stand-up command: compose every launcher primitive into a single
 * boot of the whole crew from the operator config (the crew-start rule: derive and launch the configured roster from one validated config, the atomic stand-up rule: launch the complete roster or fail without leaving a partial crew). This module owns the
 * ORDER and the composition only; every step is a merged child it wires read-only, never
 * reimplements — config (the validated-config rule: parse channel settings, role tiers, and CLI version once before launch), version-assert (the pre-launch CLI-version check), ensure-tracker (the tracker-start rule: reuse a live tracker or start exactly one before any session launches), session-set
 * (the role-binding rule: each session receives the launcher-assigned role and engine-instance identity), bind (the roster-set rule: derive one session per bridge and the configured number per engine from the role map), tmux-placement (the pane-placement rule: map each derived session to a deterministic tmux pane).
 *
 * The one non-obvious thing: the orchestration is FAIL-LOUD with NO PARTIAL CREW. The steps run in
 * the mandated order — read config → assert the pinned CLI version → ensure the tracker → derive the
 * roster session set → build EVERY per-session bind + compute ALL tmux placements → launch. Every
 * bind and every placement is resolved (and validated) BEFORE the first session launches, so any
 * precondition failure — a drifted CLI pin, a missing config dimension, an inert channel, a colliding
 * pane label — aborts with a named error while zero sessions are up, never a half-launched
 * crew. No session is hand-launched: the launch of each `claude` session, bound to its role lease, is
 * the injected `launch` step the orchestration drives for the whole derived set (all panes of one
 * tiled crew window, founder ruling the rollback rule: clean launcher-owned artifacts after a failed or retired launch).
 *
 * The side-effecting steps are injected (defaulting to production) so the composition is pure over
 * its inputs and unit-testable end to end — the same injection idiom version-assert (its version
 * reader) and session-set (its instance-id generator) already use.
 */
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {Effect, type FileSystem, type Path, Schema} from "effect";
import {SESSION_SERVER_NAME} from "../crew/index.ts";
import type {RendezvousResolutionError} from "../tracker/index.ts";
import {
	buildSessionBind,
	type ChannelPluginNotAllowedError,
	type CrewServerNotRegisteredError,
	type CrewSessionBinUnresolvableError,
	type SessionBind,
} from "./bind.ts";
import {
	type LaunchConfig,
	type LaunchConfigError,
	readLaunchConfig,
	resolveProjectConfigPath,
} from "./config.ts";
import {
	ensureTrackerRunning,
	type TrackerHandle,
	type TrackerNotServingError,
} from "./ensure-tracker.ts";
import {
	type CrewMcpEntry,
	crewRunRoot,
	ensurePaneCwd,
	ProjectScopeWriteError,
	reapCrewProjectScopeFor,
	registerCrewProjectScope,
} from "./register-project-scope.ts";
import {type CrewSession, deriveSessionSet} from "./session-set.ts";
import {
	computeTmuxPlacement,
	type PlacementTarget,
	type RosterSession,
	type TmuxPaneCollisionError,
} from "./tmux-placement.ts";
import {
	assertPinnedCliVersion,
	type CliVersionAssertError,
	readInstalledCliVersionOutput,
} from "./version-assert.ts";

/** A `claude` session that could not be launched into its pane of the crew window — carries the role + pane it named. */
export class StandUpLaunchError extends Schema.TaggedErrorClass<StandUpLaunchError>()(
	"pipeline-crew-mcp/standup/StandUpLaunchError",
	{
		role: Schema.String,
		pane: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * The named fallback tmux session could not be ensured (the `has-session` probe missed AND the create failed
 * to come up). This is only the OUTSIDE-tmux edge: run inside tmux, stand-up opens windows in the caller's
 * current session and never creates one (founder ruling the tmux-host rule: derive placement from the caller session at launch rather than persisted config) — a created session is the fallback alone.
 */
export class TmuxSessionEnsureError extends Schema.TaggedErrorClass<TmuxSessionEnsureError>()(
	"pipeline-crew-mcp/standup/TmuxSessionEnsureError",
	{
		session: Schema.String,
		reason: Schema.String,
	},
) {}

/**
 * The outcome of running a `tmux` client to exit: its pid and exit code/signal, plus — when the binary
 * itself could not be spawned or emitted `error` — a spawn-level message. `code === 0` with no `spawnError`
 * is the only success; every other shape is a launch that did not come up.
 */
export interface TmuxRun {
	readonly pid: number | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** The client's captured stdout — carries `display-message` output for the target-session probe. */
	readonly stdout: string;
	readonly spawnError: string | undefined;
}

/** Run a `tmux` client command to its exit. Injected in tests to drive the exit-code paths without a real tmux. */
export type TmuxRunner = (args: readonly string[]) => Effect.Effect<TmuxRun>;

/**
 * Run `tmux <args>` and resolve once the client process EXITS, carrying its exit code — the async exit the
 * old `Effect.try`-sync-only launcher never inspected (the tmux-host rule: derive placement from the caller session at launch rather than persisted config). No detach/unref: `tmux` is client-server, so
 * the CLI is a short-lived client that hands the request to the tmux server and exits (bounded to await);
 * the `claude` process it places lives under the tmux server and outlives this launcher regardless. Never
 * fails — an operational spawn failure (ENOENT/EACCES) arrives on the async `error` event, captured as
 * `spawnError` data so each caller maps it to its own typed error (no raw try/catch: `spawn` reports
 * operational errors via `error`, not a throw). This mirrors ensure-tracker's `Effect.callback` node-event idiom.
 */
export const runTmux: TmuxRunner = (args) =>
	Effect.callback<TmuxRun>((resume) => {
		const child = spawn("tmux", [...args], {stdio: ["ignore", "pipe", "ignore"]});
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		let settled = false;
		const settle = (run: TmuxRun) => {
			if (settled) return;
			settled = true;
			child.removeAllListeners();
			resume(Effect.succeed(run));
		};
		child.once("error", (cause) =>
			settle({pid: child.pid, code: null, signal: null, stdout, spawnError: String(cause)}),
		);
		child.once("exit", (code, signal) =>
			settle({pid: child.pid, code, signal, stdout, spawnError: undefined}),
		);
	});

/** One derived session's full launch plan: its roster identity, its launch bind (argv), its tmux placement, and its cwd. */
export interface LaunchPlan {
	readonly session: CrewSession;
	readonly bind: SessionBind;
	readonly placement: PlacementTarget;
	/**
	 * This pane's distinct, git-valid launch cwd — the `~/.claude.json → projects[<cwd>]` key its crew
	 * server is registered under, and the `tmux -c` dir it boots in. Distinct per pane so each sees ONLY
	 * its own persisted-scope entry at boot, never a sibling's (which would storm the role lease, the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure).
	 */
	readonly cwd: string;
	/** Absolute operator config path inherited by this role despite its isolated pane cwd. */
	readonly crewConfigPath: string;
}

/** A launched crew session: the role + lease it came up holding, the crew window + pane it lives in, and its pid. */
export interface LaunchedSession {
	readonly role: string;
	/** The role-lease key inbox address the session-set minted (`inbox://<role>[/<instance>]`). */
	readonly address: string;
	/** The single tiled crew window every session shares — a tmux window id/target that later panes split into. */
	readonly window: string;
	/** This session's pane label within the crew window (its role slug or engine instance id). */
	readonly pane: string;
	readonly pid: number | undefined;
}

/** Every way stand-up can abort — the union of every wired child's error plus the launch error. */
export type StandUpError =
	| LaunchConfigError
	| CliVersionAssertError
	| TrackerNotServingError
	| RendezvousResolutionError
	| CrewSessionBinUnresolvableError
	| CrewServerNotRegisteredError
	| ChannelPluginNotAllowedError
	| ProjectScopeWriteError
	| TmuxPaneCollisionError
	| TmuxSessionEnsureError
	| StandUpLaunchError;

/**
 * Render any crew tagged error for the operator: the tag plus its diagnostic data fields. `String(error)` on a
 * `Schema.TaggedErrorClass` prints only the tag and drops the fields — yet the fields are the payload an operator
 * needs (which tmux step + exit code failed, in which role/pane), so surface every schema data field alongside
 * the tag. Field-generic on purpose: every error's diagnostic surfaces regardless of its field shape, so a future
 * member's fields can't silently regress to tag-only. `Cause.pretty` is not a substitute here: it prints tag +
 * stack but not the schema fields (the command-surface rule: expose stand-up as a single CLI subcommand). Shared by the stand-up path and the single-member membership ops (the membership rule: add, remove, or respawn one role without restarting the whole crew).
 */
export const renderTaggedError = (error: {readonly _tag: string}): string => {
	const detail = Object.entries(error)
		.filter(([key]) => key !== "_tag")
		.map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
		.join(", ");
	return detail ? `${error._tag} (${detail})` : error._tag;
};

/** Render a stand-up abort — the `StandUpError`-typed alias over the shared field-generic renderer. */
export const renderStandUpError = (error: StandUpError): string => renderTaggedError(error);

/** What `register` commits in one shot: every pane's `.mcp.json` entry, plus the run/project context that locates them. */
export interface ProjectScopeRegisterInput {
	readonly projectRoot: string;
	readonly runId: string;
	readonly serverName: string;
	readonly entries: readonly CrewMcpEntry[];
}

/**
 * The project-scope collaborator the launcher registers each pane's crew server through (the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure) — the
 * one injected seam for every filesystem side effect, so the whole boot is unit-tested with no real
 * file. `reap` removes a prior (crashed) run's crew-run dir tree at stand-up start; `paneCwd` mints a
 * pane's distinct git-valid launch cwd (where its leaf `.mcp.json` lands); `register` emits every
 * pane's `.mcp.json`, and nothing else.
 *
 * `register` makes a pane's server VISIBLE only. The two boot gates that decide whether the CLI ever
 * spawns it — folder trust in `~/.claude.json`, and the server name in `enabledMcpjsonServers` in
 * merged settings — are operator-owned host state that no launch path seeds or verifies. See ADR 0003.
 */
export interface ProjectScopeRegistrar {
	readonly reap: (
		projectRoot: string,
		serverName: string,
	) => Effect.Effect<void, ProjectScopeWriteError>;
	readonly paneCwd: (
		projectRoot: string,
		runId: string,
		paneLabel: string,
	) => Effect.Effect<string, ProjectScopeWriteError>;
	readonly register: (
		input: ProjectScopeRegisterInput,
	) => Effect.Effect<void, ProjectScopeWriteError>;
}

/** The production project-scope registrar: the real crew-run reaper, per-pane cwd, and `.mcp.json` register (visibility only — see ADR 0003). */
export const productionProjectScopeRegistrar: ProjectScopeRegistrar = {
	reap: (projectRoot, serverName) => reapCrewProjectScopeFor(projectRoot, serverName),
	paneCwd: (projectRoot, runId, paneLabel) =>
		Effect.try({
			try: () => ensurePaneCwd(projectRoot, runId, paneLabel),
			catch: (cause) =>
				new ProjectScopeWriteError({
					configPath: `${crewRunRoot(projectRoot)}/${runId}/${paneLabel}`,
					reason: `cannot ensure pane cwd: ${String(cause)}`,
				}),
		}),
	register: (input) => registerCrewProjectScope(input),
};

export interface StandUpInput {
	/** The project root the tracker + every session join (the per-project socket key). */
	readonly projectRoot: string;
	/** The channel-ref name each session's own crew MCP server registers under. Default: `SESSION_SERVER_NAME`. */
	readonly serverName?: string;
	/** Mints the id for this stand-up's per-pane cwd dir tree (`<root>/.claude/crew-run/<runId>/`). Default: `randomUUID`. */
	readonly runId?: () => string;
	/** The project-scope collaborator (the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure). Default: `productionProjectScopeRegistrar` (real `.mcp.json` + `~/.claude*`). */
	readonly localScope?: ProjectScopeRegistrar;
	/** The launch dimensions to stand up under. Default: read the operator crew config (`readLaunchConfig`). */
	readonly config?: Effect.Effect<LaunchConfig, LaunchConfigError>;
	/** The installed-CLI-version reader the pin is asserted against. Default: the real `claude --version`. */
	readonly readVersionOutput?: Effect.Effect<string, unknown>;
	/** Start-or-reuse the repo's tracker at its canonical rendezvous. Default: `ensureTrackerRunning` (detached standing process). */
	readonly ensureTracker?: (
		projectRoot: string,
	) => Effect.Effect<TrackerHandle, TrackerNotServingError | RendezvousResolutionError>;
	/** Mints each engine instance's distinct id. Default: `randomUUID` (the generator sessions use at runtime). */
	readonly instanceId?: () => string;
	/** Resolve the tmux session windows open into — the caller's current session, else a created fallback.
	 * Default: `resolveTargetTmuxSession` (reads `$TMUX` + `display-message`). */
	readonly resolveTargetSession?: () => Effect.Effect<string, TmuxSessionEnsureError>;
	/** Launch one planned session as a pane of the crew window under `targetSession`, bound to its role lease. The
	 * first session (`intoWindow` undefined) opens the crew window and returns its id; every later session splits
	 * into that window id. `crewSize` is how many panes the finished window holds — a placement hint a backend
	 * that cannot re-tile after the fact needs (see `TerminalBackend.launch`). Default: `launchSessionInTmux`. */
	readonly launch?: (
		plan: LaunchPlan,
		targetSession: string,
		intoWindow: string | undefined,
		crewSize?: number,
	) => Effect.Effect<LaunchedSession, StandUpLaunchError>;
}

/** What a completed stand-up returns: the tracker it ensured and every session it launched, in roster order. */
export interface StandUpResult {
	readonly tracker: TrackerHandle;
	readonly launched: readonly LaunchedSession[];
}

/**
 * The already-resolved launch dimensions one session's plan is built against — the shared context
 * both the whole-crew stand-up and a single-member `spawn-role` (the membership rule: add, remove, or respawn one role without restarting the whole crew) hand `buildLaunchPlan`, so
 * the per-session bind + cwd derivation is ONE code path (never forked between the two callers).
 */
export interface SessionPlanContext {
	readonly projectRoot: string;
	readonly serverName: string;
	readonly config: LaunchConfig;
	/** The id of the cwd-dir tree this session's launch cwd lands under (`<root>/.claude/crew-run/<runId>/`). */
	readonly runId: string;
	readonly localScope: ProjectScopeRegistrar;
	/** The resolved config file read at launch, propagated to the pane as `CREW_CONFIG`. */
	readonly crewConfigPath: string;
}

/**
 * Build ONE derived session's full launch plan: its launch bind (argv, the roster-set rule: derive one session per bridge and the configured number per engine from the role map), its distinct git-valid
 * launch cwd (where the pane's leaf `.mcp.json` lands, the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure), and its already-computed tmux placement.
 * This is the per-role launch-plan step `runStandUp` runs for every roster session AND `spawn-role`
 * (the membership rule: add, remove, or respawn one role without restarting the whole crew) runs for one on-demand session — extracted, not forked, so single-role and whole-crew launch
 * derive identically (a bridge binds its singleton address, an engine binds its per-instance identity).
 */
export const buildLaunchPlan = (
	session: CrewSession,
	placement: PlacementTarget,
	ctx: SessionPlanContext,
): Effect.Effect<
	LaunchPlan,
	| CrewSessionBinUnresolvableError
	| CrewServerNotRegisteredError
	| ChannelPluginNotAllowedError
	| ProjectScopeWriteError,
	FileSystem.FileSystem | Path.Path
> =>
	Effect.gen(function* () {
		const bind = yield* buildSessionBind({
			role: session.role,
			projectRoot: ctx.projectRoot,
			serverName: ctx.serverName,
			// Thread the session-set-derived per-instance identity so the launched engine binds it rather
			// than re-minting its own (the registration rule: every launched session registers its channel server with its stable role and instance identity seam 3); a bridge is a singleton and has none.
			instance: session.kind === "engine" ? session.instance : undefined,
			// The role's configured model tier → the session's `--model` (the optional role-tier setting); undefined for a role that
			// set none, so bind emits no `--model` and it boots on the CLI default.
			tier: ctx.config.roleTiers[session.role],
			channels: ctx.config.channels,
		});
		// The pane's distinct launch cwd — where its leaf `.mcp.json` lands (the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure). Resolved here so an
		// unwritable cwd fails closed before the register/launch.
		const cwd = yield* ctx.localScope.paneCwd(ctx.projectRoot, ctx.runId, placement.paneLabel);
		return {session, bind, placement, cwd, crewConfigPath: ctx.crewConfigPath};
	});

/**
 * Project a derived `CrewSession` onto the `RosterSession` tmux-placement consumes: a bridge places
 * on a pane labelled by its role slug, an engine on its generated per-instance id (an operator cannot
 * name N dynamic engines). Both pane labels derive from identity — there is no config tmux dimension.
 */
export const toRosterSession = (session: CrewSession): RosterSession =>
	session.kind === "engine"
		? {kind: "engine", id: session.instance}
		: {kind: "bridge", role: session.role};

/**
 * The named session stand-up falls back to only when run OUTSIDE tmux — inside tmux the caller's own current
 * session is the target and nothing is created (founder ruling the tmux-host rule: derive placement from the caller session at launch rather than persisted config). A launcher default, not a config input.
 */
export const FALLBACK_TMUX_SESSION = "crew";

/**
 * Ensure a named tmux session exists: probe `has-session`, and create (`new-session -d`) only when it is
 * absent. This runs ONLY on the outside-tmux fallback path (`resolveTargetTmuxSession`) — a create that does
 * not come up fails closed with `TmuxSessionEnsureError`. The tmux runner is injected so the has-session /
 * create branches are unit-tested without a real tmux.
 */
export const ensureNamedTmuxSession = (
	session: string,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<void, TmuxSessionEnsureError> =>
	Effect.gen(function* () {
		const probe = yield* runTmuxCommand(["has-session", "-t", session]);
		if (probe.spawnError === undefined && probe.code === 0) return;
		const created = yield* runTmuxCommand(["new-session", "-d", "-s", session]);
		if (created.spawnError !== undefined || created.code !== 0) {
			return yield* Effect.fail(
				new TmuxSessionEnsureError({
					session,
					reason:
						created.spawnError ??
						`tmux new-session for "${session}" exited ${created.code ?? created.signal}`,
				}),
			);
		}
	});

/**
 * Resolve which tmux session stand-up opens its windows into (founder ruling the tmux-host rule: derive placement from the caller session at launch rather than persisted config — the fix's inverted half:
 * open windows in the operator's CURRENT session, never a hardcoded `crew`). Inside tmux (`$TMUX` set) the
 * caller's current session name is read via `display-message -p '#{session_name}'`, resolved through the
 * inherited `$TMUX` — that session always exists, so the old "session doesn't exist" failure dissolves. Only
 * OUTSIDE tmux (or when the current-session name can't be read) is a session created: the named fallback,
 * ensured to exist. `inTmux` + the runner are injected so both paths are unit-tested without a real tmux.
 */
export const resolveTargetTmuxSession = (
	opts: {readonly inTmux: boolean; readonly fallbackSession: string},
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<string, TmuxSessionEnsureError> =>
	Effect.gen(function* () {
		if (opts.inTmux) {
			const shown = yield* runTmuxCommand(["display-message", "-p", "#{session_name}"]);
			const name = shown.stdout.trim();
			if (shown.spawnError === undefined && shown.code === 0 && name.length > 0) return name;
			// Inside tmux but the current session name was unreadable — fall through to the created fallback.
		}
		yield* ensureNamedTmuxSession(opts.fallbackSession, runTmuxCommand);
		return opts.fallbackSession;
	});

/** The production target-session resolver: current session when inside tmux, the named fallback otherwise. */
const resolveTargetSessionDefault = (): Effect.Effect<string, TmuxSessionEnsureError> =>
	resolveTargetTmuxSession({
		inTmux: process.env.TMUX !== undefined,
		fallbackSession: FALLBACK_TMUX_SESSION,
	});

/** The single tiled window every crew pane opens into (founder ruling the rollback rule: clean launcher-owned artifacts after a failed or retired launch): one window, all roles visible at once. */
export const CREW_WINDOW = "crew";

/** POSIX single-quote one argv token so the wrapping shell re-parses `claude <argv>` into the exact same words. */
const shellQuote = (token: string): string => `'${token.replace(/'/g, "'\\''")}'`;

/**
 * The pane command tmux runs — `claude` spawned THROUGH an interactive login shell, not as the direct
 * tmux pane process. Grounded on the startup-order rule: use an interactive login shell so a required channel-approval dialog can complete before the pane exits diagnosis against CLI 2.1.214: a recent CLI update added
 * a startup confirmation dialog for `--dangerously-load-development-channels` (the crew channel flag
 * config.ts's fail-closed cross-field check forces, since the crew's top-level `server:` ref only
 * registers in development mode). Exec'd DIRECTLY as the tmux pane process, `claude` cannot set up its
 * interactive raw-mode stdin for that dialog and the pane EXITS 1 immediately — collapsing the crew
 * window and failing every sibling pane's split ("no live pane"). Spawned as a child of an interactive
 * login shell (`-lic`), the dialog renders and the pane WAITS for the operator's accept — the
 * founder-endorsed attended-boot interim (the startup-order rule: use an interactive login shell so a required channel-approval dialog can complete before the pane exits, until the post-preview allowlist path via the launch-error rule: retain actionable child-process output and clean launcher artifacts after failure removes
 * the dialog). Deliberately NOT a synthetic-keystroke auto-accept (the version-fragile anti-pattern the
 * founder vetoed): it only restores the dialog to a state a human — or a `synchronize-panes` Enter —
 * can accept. The operator's `$SHELL` runs it (falling back to `zsh`, the macOS default the workaround
 * was proven on); every token is single-quoted so the shell re-parses the argv verbatim.
 */
export const paneClaudeCommand = (
	argv: readonly string[],
	crewConfigPath?: string,
): readonly string[] => {
	const shell = process.env.SHELL || "zsh";
	const envPrefix = crewConfigPath === undefined ? [] : [`CREW_CONFIG=${shellQuote(crewConfigPath)}`];
	const command = [...envPrefix, "claude", ...argv].map((token) =>
		token.startsWith("CREW_CONFIG=") ? token : shellQuote(token),
	).join(" ");
	return [shell, "-lic", command];
};

/** Map a non-zero exit / spawn error from one tmux step to the fail-loud `StandUpLaunchError` naming the role + pane. */
const launchFailure = (
	session: CrewSession,
	pane: string,
	run: TmuxRun,
	what: string,
): StandUpLaunchError =>
	new StandUpLaunchError({
		role: session.role,
		pane,
		reason:
			run.spawnError !== undefined
				? `cannot ${what} for pane "${pane}": ${run.spawnError}`
				: `tmux ${what} for pane "${pane}" exited ${run.code ?? run.signal} (no live pane)`,
	});

/**
 * The production launcher: place one `claude` session as a PANE of the single crew window under `targetSession`
 * (the resolved caller session, the tmux-host rule: derive placement from the caller session at launch rather than persisted config), then CONFIRM the pane came up before counting it. The first session
 * (`intoWindow` undefined) opens the crew window with `new-window` and returns its id; every later session
 * `split-window`s into that window id and re-`select-layout tiled`s so all roles stay evenly tiled and visible
 * at once (founder ruling the rollback rule: clean launcher-owned artifacts after a failed or retired launch, refining the tmux-host rule: derive placement from the caller session at launch rather than persisted config). `runTmux` awaits each client's async exit, so a spawn failure
 * or any non-zero exit — the swallowed failure the tmux-host rule: derive placement from the caller session at launch rather than persisted config closed — fails closed with `StandUpLaunchError` naming the
 * role + pane; a `LaunchedSession` therefore only ever exists for a confirmed-live pane. The tmux runner is
 * injected so the new-window / split-window / select-layout exit-code paths are unit-tested.
 */
export const launchSessionInTmux = (
	plan: LaunchPlan,
	targetSession: string,
	intoWindow: string | undefined,
	runTmuxCommand: TmuxRunner = runTmux,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.gen(function* () {
		const {placement, bind, session, cwd} = plan;
		const pane = placement.paneLabel;
		if (intoWindow === undefined) {
			// First session: open the crew window and capture its id (`-P -F '#{window_id}'`) so every later
			// pane splits into exactly this window, never a stale same-named one. `-c <cwd>` boots the pane in
			// its distinct launch cwd — the persisted-scope `projects[]` key its crew server is registered under (the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure).
			// The pane runs `claude` THROUGH a login shell so the dev-channel startup dialog waits instead of
			// exiting 1 (the startup-order rule: use an interactive login shell so a required channel-approval dialog can complete before the pane exits, see paneClaudeCommand).
			const opened = yield* runTmuxCommand([
				"new-window",
				"-t",
				targetSession,
				"-n",
				CREW_WINDOW,
				"-c",
				cwd,
				"-P",
				"-F",
				"#{window_id}",
				...paneClaudeCommand(bind.argv, plan.crewConfigPath),
			]);
			if (opened.spawnError !== undefined || opened.code !== 0) {
				return yield* Effect.fail(launchFailure(session, pane, opened, "new-window"));
			}
			const window = opened.stdout.trim() || CREW_WINDOW;
			return {role: session.role, address: session.address, window, pane, pid: opened.pid};
		}
		// Later session: split into the crew window in this pane's distinct launch cwd (`-c`), then re-tile.
		// Same login-shell wrap as the first pane so the dev-channel dialog waits instead of exiting 1 (the startup-order rule: use an interactive login shell so a required channel-approval dialog can complete before the pane exits).
		const split = yield* runTmuxCommand([
			"split-window",
			"-t",
			intoWindow,
			"-c",
			cwd,
			...paneClaudeCommand(bind.argv, plan.crewConfigPath),
		]);
		if (split.spawnError !== undefined || split.code !== 0) {
			return yield* Effect.fail(launchFailure(session, pane, split, "split-window"));
		}
		const tiled = yield* runTmuxCommand(["select-layout", "-t", intoWindow, "tiled"]);
		if (tiled.spawnError !== undefined || tiled.code !== 0) {
			return yield* Effect.fail(launchFailure(session, pane, tiled, "select-layout tiled"));
		}
		return {role: session.role, address: session.address, window: intoWindow, pane, pid: split.pid};
	});

/**
 * Stand up the whole crew from the operator config, in the mandated order and fail-loud with no
 * partial crew (the atomic stand-up rule: launch the complete roster or fail without leaving a partial crew): read config → assert the pinned CLI version → ensure the tracker →
 * derive the roster session set → build every per-session bind + compute all tmux placements →
 * launch each session bound to its role lease. Every derivation and validation completes before the
 * first launch, so any precondition failure aborts (naming its cause) with zero sessions up.
 */
export const runStandUp = (
	input: StandUpInput,
): Effect.Effect<StandUpResult, StandUpError, FileSystem.FileSystem | Path.Path> =>
	Effect.gen(function* () {
		const {projectRoot} = input;
		const serverName = input.serverName ?? SESSION_SERVER_NAME;
		const instanceId = input.instanceId ?? randomUUID;
		const runId = (input.runId ?? randomUUID)();
		const localScope = input.localScope ?? productionProjectScopeRegistrar;
		const ensureTracker = input.ensureTracker ?? ensureTrackerRunning;
		const resolveTargetSession = input.resolveTargetSession ?? resolveTargetSessionDefault;
		// The tmux default takes an injected runner where the seam takes the placement hint, so it is
		// adapted rather than passed straight through — tmux re-tiles the window itself and has no use
		// for a crew size.
		const launch: NonNullable<StandUpInput["launch"]> =
			input.launch ??
			((plan, targetSession, intoWindow) => launchSessionInTmux(plan, targetSession, intoWindow));

		const crewConfigPath = resolveProjectConfigPath(projectRoot);
		const config = yield* input.config ?? readLaunchConfig({CREW_CONFIG: crewConfigPath});
		// Fail fast on a version drift before starting the tracker or any session — channels vary
		// across CLI versions, so a mismatch is a stand-up to refuse (version-assert.ts / the pre-launch CLI-version check).
		yield* assertPinnedCliVersion(config, input.readVersionOutput ?? readInstalledCliVersionOutput);
		const tracker = yield* ensureTracker(projectRoot);

		// Start-of-stand-up reaper (crash-safety, the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure): clear any prior run's
		// crew-run dirs — a launcher that died mid-run leaves leftovers this run clears here, before it
		// re-mints. Host boot-gate state is operator-owned and is not touched (ADR 0003).
		yield* localScope.reap(projectRoot, serverName);

		const sessions = deriveSessionSet({engineCount: config.engineCount, instanceId});

		// Resolve EVERY bind + placement + cwd before launching anything — this is the no-partial-crew
		// line: an inert channel or a colliding window fails here, while zero sessions are up.
		const placements = yield* computeTmuxPlacement(sessions.map(toRosterSession));
		// `placements` is derived from `sessions` in order, so the index is always populated; the die guard
		// is the unreachable branch that satisfies noUncheckedIndexedAccess. Each session's full plan (bind,
		// placement, distinct launch cwd) is built by the shared `buildLaunchPlan` — the same per-role step
		// `spawn-role` runs for one on-demand session (the membership rule: add, remove, or respawn one role without restarting the whole crew), never a forked launch path. Serial on purpose
		// (`concurrency: 1`): the plan build stays sequential so a failure fails closed with zero panes up.
		const plans = yield* Effect.forEach(
			sessions,
			(session, i) => {
				const placement = placements[i];
				if (placement === undefined) {
					return Effect.die(`stand-up placement zip out of range for session "${session.role}"`);
				}
				return buildLaunchPlan(session, placement, {
					projectRoot,
					serverName,
					config,
					runId,
					localScope,
					crewConfigPath,
				});
			},
			{concurrency: 1},
		);

		// Register every pane's crew server as a project-scope leaf `.mcp.json` — one fail-closed step (the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure): the channel resolver reads the
		// persisted project scope, never the old inline `--mcp-config`. Each `.mcp.json` sits in the pane's
		// own cwd, on no sibling's ancestor chain, so a pane sees ONLY its own server (no role-lease storm).
		// This makes the server VISIBLE only: the boot gates that decide whether the CLI ever spawns it are
		// operator-owned and seeded by no launch path (register-project-scope.ts, ADR 0003).
		yield* localScope.register({
			projectRoot,
			runId,
			serverName,
			entries: plans.map(
				(plan): CrewMcpEntry => ({
					cwd: plan.cwd,
					serverName: plan.bind.serverName,
					serverConfig: plan.bind.serverConfig,
				}),
			),
		});

		// Resolve the target tmux session before placing any pane: the caller's CURRENT session inside
		// tmux (which always exists — dissolving the fresh-machine "no crew session" failure), else a
		// created fallback (founder ruling the tmux-host rule: derive placement from the caller session at launch rather than persisted config). Last precondition before the no-partial-crew launch loop.
		const targetSession = yield* resolveTargetSession();
		// Launch the whole crew into ONE tiled window (founder ruling the rollback rule: clean launcher-owned artifacts after a failed or retired launch): the first session opens the
		// crew window, and its resolved window id threads into every later session so they split into that
		// exact window. Sequential (not `forEach`) because each pane splits the window the first one opened;
		// any failed launch short-circuits fail-loud with no partial crew.
		const launched: LaunchedSession[] = [];
		let crewWindow: string | undefined;
		for (const plan of plans) {
			// The roster length rides along: a backend with no `select-layout tiled` cannot re-tile the
			// window after the fact, so it needs the FINISHED pane count to size each split (#144).
			const session = yield* launch(plan, targetSession, crewWindow, plans.length);
			launched.push(session);
			crewWindow ??= session.window;
		}
		return {tracker, launched};
	});

/** What a stand-down consumes: the project whose crew `.mcp.json` files + crew-run dirs to tear down. */
export interface StandDownInput {
	readonly projectRoot: string;
	/** The crew server name the reap is keyed by. Default: `SESSION_SERVER_NAME`. Nothing is revoked (ADR 0003). */
	readonly serverName?: string;
	/**
	 * Remove the launcher-owned crew-run dir tree (every pane's leaf `.mcp.json` with it). Default:
	 * `reapCrewProjectScopeFor`, which removes that tree and nothing else — it revokes no approval and
	 * never opens `~/.claude/settings.json` (ADR 0003). Injected in tests so no real dir is removed.
	 */
	readonly reap?: () => Effect.Effect<void, ProjectScopeWriteError>;
}

/**
 * Tear this run's crew registration down (the symmetric `stand-down`, the channel-probe rule: distinguish a connected server, a brief boot delay, and a persistent failure): remove the launcher-owned
 * crew-run dir tree (every pane's `.mcp.json` with it). The operator's server approval is left in
 * place — stand-down owns launcher artifacts, not host state (ADR 0003).
 * Removal is safe even while a crew is live — a booted stdio server is never re-read against its
 * `.mcp.json`. Idempotent: a second stand-down is a clean no-op.
 */
export const runStandDown = (input: StandDownInput): Effect.Effect<void, ProjectScopeWriteError> =>
	Effect.gen(function* () {
		const {projectRoot} = input;
		const serverName = input.serverName ?? SESSION_SERVER_NAME;
		const reap = input.reap ?? (() => reapCrewProjectScopeFor(projectRoot, serverName));
		yield* reap();
	});
