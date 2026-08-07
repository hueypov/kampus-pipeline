/**
 * standup/herdr — the second terminal backend: herdr in the same SURVIVING role tmux holds, window
 * manager and nothing more. The launcher coordinates the crew over the channels substrate; this layer
 * only puts each launched session on the operator's screen, exactly as `orchestrate.ts`'s tmux path
 * does. It is selected per-install through the `terminal` config dimension (see `terminal.ts`), so an
 * operator who does not want tmux's learning curve stands the same crew up unchanged.
 *
 * The one non-obvious thing: herdr does NOT take a command at pane-creation time. tmux launches a pane
 * AND its process in one `new-window`/`split-window` call; herdr splits the topology first
 * (`tab create` / `pane split`, which boot an interactive shell) and you then type the command into
 * that shell with `pane run`. So every launch here is TWO calls, and the failure surface is wider: a
 * created-but-never-commanded pane is a half-launch. Both steps are therefore checked and any failure
 * maps to the same `StandUpLaunchError` the tmux path raises, keeping the no-partial-crew contract
 * identical across backends.
 *
 * Two consequences of that shape are worth knowing before reading the code:
 *
 *   - **No login-shell wrap.** The tmux path runs `claude` through `$SHELL -lic` because a pane's
 *     direct process gets no interactive raw-mode stdin, and the dev-channel startup dialog then exits
 *     the pane 1 (see `paneClaudeCommand`). A herdr pane is ALREADY an interactive shell — `pane run`
 *     types into it — so `claude` is a child of an interactive shell for free and the dialog renders
 *     normally. Wrapping again would only nest a second shell.
 *   - **`CREW_CONFIG` rides `--env`, not a command prefix.** `tab create` / `pane split` take
 *     `--env KEY=VALUE` for the shell they launch, so the pane's `claude` inherits it directly instead
 *     of the tmux path's shell-quoted `CREW_CONFIG=… claude …` prefix.
 *
 * herdr has no `select-layout tiled`, so the even tiling tmux gets for free is approximated by
 * alternating the split direction (right, down, right, …) against the tab's live pane count. This is
 * deliberately a heuristic: it keeps panes from degenerating into unusably narrow columns, which is the
 * property that actually matters, and it is the geometry rule herdr's own agent guide prescribes.
 */
import {spawn} from "node:child_process";
import {Effect} from "effect";
import {
	type LaunchedSession,
	type LaunchPlan,
	StandUpLaunchError,
	TmuxSessionEnsureError,
} from "./orchestrate.ts";
import {CrewPaneKillError, CrewPaneNotFoundError, CrewWindowNotRunningError} from "./single-role.ts";

/**
 * The ONE tab the whole crew lands in, as a pane each — the herdr twin of tmux's single tiled `crew`
 * window, and for the same reason: every role stays visible at once instead of hiding behind a tab
 * switch. A tab per role is explicitly NOT the shape; `stand-up` creates this tab once for the first
 * session and every later session splits a pane inside it.
 *
 * It is deliberately its own constant rather than tmux's `CREW_WINDOW`: this string is what the
 * operator reads on their herdr tab bar, so it names the thing they are running ("pipeline"), and it
 * is the handle `resolveCrewTabId` matches on when `spawn-role` looks the running crew back up — so
 * the create site and the lookup site must never drift apart.
 */
export const CREW_TAB_LABEL = "pipeline";

/**
 * The outcome of running a `herdr` client to exit — the same shape `TmuxRun` carries, for the same
 * reason: `code === 0` with no `spawnError` is the only success, and every other shape is a step that
 * did not come up. herdr's CLI writes its JSON response on stdout and its server errors as JSON on
 * stderr with exit status 1 (syntax errors exit 2), so the exit code alone separates the two.
 */
export interface HerdrRun {
	readonly pid: number | undefined;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	/** The client's captured stdout — the JSON response every `list`/`create`/`split` call is read from. */
	readonly stdout: string;
	readonly spawnError: string | undefined;
}

/** Run a `herdr` client command to its exit. Injected in tests to drive the exit-code paths without a real herdr. */
export type HerdrRunner = (args: readonly string[]) => Effect.Effect<HerdrRun>;

/**
 * Run `herdr <args>` and resolve once the client EXITS, carrying its exit code and stdout. Mirrors
 * `runTmux` exactly — herdr is likewise a short-lived client that hands the request to a long-running
 * server over its socket and exits, so this is bounded to await and the pane processes it creates
 * outlive the launcher regardless. Never fails: an operational spawn failure (ENOENT when herdr is not
 * installed) arrives on the async `error` event and is captured as `spawnError` data, so each caller
 * maps it to its own typed error.
 */
export const runHerdr: HerdrRunner = (args) =>
	Effect.callback<HerdrRun>((resume) => {
		const child = spawn("herdr", [...args], {stdio: ["ignore", "pipe", "ignore"]});
		let stdout = "";
		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
		});
		let settled = false;
		const settle = (run: HerdrRun) => {
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

/** A herdr CLI response's `result` object — the only part any caller reads. Shape is per-command, so it stays unknown-keyed. */
type HerdrResult = Record<string, unknown>;

/**
 * Read a successful run's `.result` object. Returns `undefined` for a failed run, non-JSON stdout, or a
 * response without a `result` — every one of which is a step the caller must fail closed on, so they
 * deliberately collapse to one "no usable result" signal rather than three indistinguishable throws.
 */
export const herdrResult = (run: HerdrRun): HerdrResult | undefined => {
	if (run.spawnError !== undefined || run.code !== 0) return undefined;
	try {
		const parsed: unknown = JSON.parse(run.stdout.trim());
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const result = (parsed as {result?: unknown}).result;
		return typeof result === "object" && result !== null ? (result as HerdrResult) : undefined;
	} catch {
		return undefined;
	}
};

/** Read a string field off a herdr result object (or a nested one), returning undefined when absent or not a string. */
const strField = (obj: unknown, key: string): string | undefined => {
	if (typeof obj !== "object" || obj === null) return undefined;
	const value = (obj as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
};

/** Read an array field off a herdr result object, returning an empty list when absent or not an array. */
const arrField = (obj: HerdrResult, key: string): readonly unknown[] => {
	const value = obj[key];
	return Array.isArray(value) ? value : [];
};

/** Why a herdr step failed, in the operator's words — a spawn failure (herdr absent) or a non-zero exit. */
const herdrReason = (run: HerdrRun, what: string): string =>
	run.spawnError !== undefined
		? `cannot ${what}: ${run.spawnError} (is herdr installed and on PATH?)`
		: `herdr ${what} exited ${run.code ?? run.signal}`;

/** Map a failed herdr step to the fail-loud `StandUpLaunchError` naming the role + pane — the tmux path's `launchFailure` twin. */
const launchFailure = (plan: LaunchPlan, run: HerdrRun, what: string): StandUpLaunchError =>
	new StandUpLaunchError({
		role: plan.session.role,
		pane: plan.placement.paneLabel,
		reason: `${herdrReason(run, `${what} for pane "${plan.placement.paneLabel}"`)} (no live pane)`,
	});

/**
 * The env pairs a crew pane's shell is launched with. `CREW_CONFIG` is the config file resolved at
 * launch, propagated so the pane's `claude` — and every def it loads — reads the SAME operator config
 * the launcher validated, never a stale one re-resolved from the working directory.
 */
const paneEnvArgs = (crewConfigPath: string | undefined): readonly string[] =>
	crewConfigPath === undefined ? [] : ["--env", `CREW_CONFIG=${crewConfigPath}`];

/**
 * The command line `pane run` types into a crew pane's interactive shell. Every token is POSIX
 * single-quoted so the shell re-parses the argv into exactly the words the bind produced — the same
 * guarantee `paneClaudeCommand` gives the tmux path, minus its `$SHELL -lic` wrap (a herdr pane is
 * already an interactive shell; see this module's header).
 */
export const herdrPaneCommand = (argv: readonly string[]): string =>
	["claude", ...argv].map((token) => `'${token.replace(/'/g, "'\\''")}'`).join(" ");

/** The workspace label stand-up creates when no herdr workspace is open — the herdr twin of `FALLBACK_TMUX_SESSION`. */
export const FALLBACK_HERDR_WORKSPACE = "crew";

/**
 * Resolve the herdr workspace the crew tab opens under — the analogue of tmux's target session.
 * Inside a herdr-managed pane the caller's own workspace is injected as `$HERDR_WORKSPACE_ID` and is
 * used verbatim (the founder ruling the tmux path already follows: place the crew where the operator
 * IS, never a hardcoded home). Outside herdr, the first open workspace is adopted, and only when there
 * is none at all is one created. Fails closed if herdr cannot be reached or the create does not come
 * up — the same edge `ensureNamedTmuxSession` guards.
 */
export const resolveTargetHerdrWorkspace = (
	env: {readonly HERDR_WORKSPACE_ID?: string | undefined} = process.env,
	runHerdrCommand: HerdrRunner = runHerdr,
): Effect.Effect<string, TmuxSessionEnsureError> =>
	Effect.gen(function* () {
		const current = env.HERDR_WORKSPACE_ID;
		if (current !== undefined && current.length > 0) return current;

		const listed = yield* runHerdrCommand(["workspace", "list"]);
		const listResult = herdrResult(listed);
		if (listResult === undefined) {
			return yield* Effect.fail(
				new TmuxSessionEnsureError({
					session: FALLBACK_HERDR_WORKSPACE,
					reason: herdrReason(listed, "workspace list"),
				}),
			);
		}
		for (const workspace of arrField(listResult, "workspaces")) {
			const id = strField(workspace, "workspace_id");
			if (id !== undefined) return id;
		}

		// No workspace is open at all (a herdr server with an empty session) — create the fallback.
		const created = yield* runHerdrCommand([
			"workspace",
			"create",
			"--label",
			FALLBACK_HERDR_WORKSPACE,
		]);
		const createResult = herdrResult(created);
		const id = createResult === undefined ? undefined : strField(createResult["workspace"], "workspace_id");
		if (id === undefined) {
			return yield* Effect.fail(
				new TmuxSessionEnsureError({
					session: FALLBACK_HERDR_WORKSPACE,
					reason: herdrReason(created, "workspace create"),
				}),
			);
		}
		return id;
	});

/** Count the panes already open in a tab — the input to the alternating split direction (see the module header). */
const paneIdsInTab = (
	workspaceId: string,
	tabId: string,
	runHerdrCommand: HerdrRunner,
): Effect.Effect<readonly string[] | undefined> =>
	runHerdrCommand(["pane", "list", "--workspace", workspaceId]).pipe(
		Effect.map((listed) => {
			const result = herdrResult(listed);
			if (result === undefined) return undefined;
			const ids: string[] = [];
			for (const pane of arrField(result, "panes")) {
				const id = strField(pane, "pane_id");
				if (id !== undefined && strField(pane, "tab_id") === tabId) ids.push(id);
			}
			return ids;
		}),
	);

/**
 * Launch one planned `claude` session as a pane of the single crew tab under `workspaceId`, then CONFIRM
 * it came up before counting it — the herdr implementation of the same contract `launchSessionInTmux`
 * holds. The first session (`intoTab` undefined) opens the crew tab with `tab create` and returns its
 * id so every later session splits into exactly that tab; later sessions `pane split` the tab's last
 * pane, alternating direction to keep the layout usable.
 *
 * Each launch is the two-step herdr shape — create the pane, then `pane run` the command into its shell
 * — and BOTH steps are checked, so a `LaunchedSession` only ever exists for a pane that was created and
 * commanded. The pane is renamed to its roster label so `retire-role` and the operator can both tell
 * the members apart.
 */
export const launchSessionInHerdr = (
	plan: LaunchPlan,
	workspaceId: string,
	intoTab: string | undefined,
	runHerdrCommand: HerdrRunner = runHerdr,
): Effect.Effect<LaunchedSession, StandUpLaunchError> =>
	Effect.gen(function* () {
		const {placement, bind, session, cwd} = plan;
		const paneLabel = placement.paneLabel;
		const env = paneEnvArgs(plan.crewConfigPath);

		let tabId: string;
		let paneId: string;
		let pid: number | undefined;

		if (intoTab === undefined) {
			// First session: open the crew tab. `--cwd` boots its shell in this pane's distinct launch cwd —
			// the persisted-scope key its crew server is registered under — and `--label` names the tab so
			// `spawn-role` can find it again later.
			const opened = yield* runHerdrCommand([
				"tab",
				"create",
				"--workspace",
				workspaceId,
				"--cwd",
				cwd,
				"--label",
				CREW_TAB_LABEL,
				"--focus",
				...env,
			]);
			const result = herdrResult(opened);
			const openedTab = result === undefined ? undefined : strField(result["tab"], "tab_id");
			const rootPane = result === undefined ? undefined : strField(result["root_pane"], "pane_id");
			if (openedTab === undefined || rootPane === undefined) {
				return yield* Effect.fail(launchFailure(plan, opened, "tab create"));
			}
			tabId = openedTab;
			paneId = rootPane;
			pid = opened.pid;
		} else {
			// Later session: split the crew tab's last pane. Alternating right/down against the live pane
			// count stands in for tmux's `select-layout tiled`, which herdr has no equivalent of.
			const existing = yield* paneIdsInTab(workspaceId, intoTab, runHerdrCommand);
			const target = existing?.at(-1);
			if (existing === undefined || target === undefined) {
				return yield* Effect.fail(
					new StandUpLaunchError({
						role: session.role,
						pane: paneLabel,
						reason: `no live pane to split in herdr tab "${intoTab}" (no live pane)`,
					}),
				);
			}
			const split = yield* runHerdrCommand([
				"pane",
				"split",
				"--pane",
				target,
				"--direction",
				existing.length % 2 === 0 ? "right" : "down",
				"--cwd",
				cwd,
				"--no-focus",
				...env,
			]);
			const result = herdrResult(split);
			const newPane = result === undefined ? undefined : strField(result["pane"], "pane_id");
			if (newPane === undefined) {
				return yield* Effect.fail(launchFailure(plan, split, "pane split"));
			}
			tabId = intoTab;
			paneId = newPane;
			pid = split.pid;
		}

		// Label the pane with its roster identity. Cosmetic for the operator, but it is also the handle
		// `retire-role` matches on, so a failure here would leave an unretireable member — fail closed.
		const renamed = yield* runHerdrCommand(["pane", "rename", paneId, paneLabel]);
		if (renamed.spawnError !== undefined || renamed.code !== 0) {
			return yield* Effect.fail(launchFailure(plan, renamed, "pane rename"));
		}

		// Step two of the herdr launch shape: type `claude <argv>` into the pane's interactive shell.
		// Until this succeeds the pane exists but hosts no session — a half-launch the crew must not count.
		const ran = yield* runHerdrCommand(["pane", "run", paneId, herdrPaneCommand(bind.argv)]);
		if (ran.spawnError !== undefined || ran.code !== 0) {
			return yield* Effect.fail(launchFailure(plan, ran, "pane run"));
		}

		return {role: session.role, address: session.address, window: tabId, pane: paneLabel, pid};
	});

/**
 * Resolve the id of the RUNNING crew tab in `workspaceId` — the tab `spawn-role` splits its new pane
 * into. Fails closed if herdr cannot be reached or no crew tab is up (run `stand-up` first), matching
 * `resolveCrewWindowId`'s contract on the tmux side.
 */
export const resolveCrewTabId = (
	workspaceId: string,
	runHerdrCommand: HerdrRunner = runHerdr,
): Effect.Effect<string, CrewWindowNotRunningError> =>
	Effect.gen(function* () {
		const listed = yield* runHerdrCommand(["tab", "list", "--workspace", workspaceId]);
		const result = herdrResult(listed);
		if (result === undefined) {
			return yield* Effect.fail(
				new CrewWindowNotRunningError({
					targetSession: workspaceId,
					reason: herdrReason(listed, `tab list for "${workspaceId}"`),
				}),
			);
		}
		for (const tab of arrField(result, "tabs")) {
			if (strField(tab, "label") === CREW_TAB_LABEL) {
				const id = strField(tab, "tab_id");
				if (id !== undefined) return id;
			}
		}
		return yield* Effect.fail(
			new CrewWindowNotRunningError({
				targetSession: workspaceId,
				reason: `no "${CREW_TAB_LABEL}" tab is running in herdr workspace "${workspaceId}" — run stand-up first`,
			}),
		);
	});

/**
 * Find the ONE crew pane for a member by its launcher-owned cwd. The tmux path matches
 * `pane_start_command` (which carries the launch `--name`); herdr exposes no start command, but it does
 * expose each pane's `cwd` — and stand-up gives every member a DISTINCT cwd ending in its unique pane
 * label (`<root>/.claude/crew-run/<runId>/<cwdLabel>`), so that path is an equally exact handle.
 * Fails closed on zero matches (already gone) or, defensively, more than one.
 */
export const findCrewPaneIdInHerdr = (
	cwdLabel: string,
	displayName: string,
	runHerdrCommand: HerdrRunner = runHerdr,
): Effect.Effect<string, CrewPaneNotFoundError> =>
	Effect.gen(function* () {
		const listed = yield* runHerdrCommand(["pane", "list"]);
		const result = herdrResult(listed);
		if (result === undefined) {
			return yield* Effect.fail(
				new CrewPaneNotFoundError({
					displayName,
					matched: 0,
					reason: herdrReason(listed, "pane list"),
				}),
			);
		}
		const matches: string[] = [];
		for (const pane of arrField(result, "panes")) {
			const id = strField(pane, "pane_id");
			const cwd = strField(pane, "cwd");
			if (id === undefined || cwd === undefined) continue;
			if (cwd.includes("/.claude/crew-run/") && cwd.endsWith(`/${cwdLabel}`)) matches.push(id);
		}
		const only = matches[0];
		if (matches.length !== 1 || only === undefined) {
			return yield* Effect.fail(
				new CrewPaneNotFoundError({
					displayName,
					matched: matches.length,
					reason:
						matches.length === 0
							? `no running crew pane matches "${displayName}" — already retired, or the crew is down`
							: `${matches.length} panes match "${displayName}" — refusing to close ambiguously`,
				}),
			);
		}
		return only;
	});

/** Close one member's herdr pane. Fails closed rather than half-tear-down, mirroring the tmux `kill-pane` step. */
export const closeHerdrPane = (
	paneId: string,
	runHerdrCommand: HerdrRunner = runHerdr,
): Effect.Effect<void, CrewPaneKillError> =>
	Effect.gen(function* () {
		const closed = yield* runHerdrCommand(["pane", "close", paneId]);
		if (closed.spawnError !== undefined || closed.code !== 0) {
			return yield* Effect.fail(
				new CrewPaneKillError({paneId, reason: herdrReason(closed, `pane close ${paneId}`)}),
			);
		}
	});
