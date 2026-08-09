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
 * herdr has no `select-layout tiled`, so the even tiling tmux gets for free is computed here instead —
 * see `planCrewSplit`, which is the whole rule and is pure arithmetic over the geometry `pane layout`
 * reports. Two things make a layout even and neither is optional: WHICH pane a seat splits, and at what
 * RATIO. Splitting the newest pane at herdr's default 50/50 — what this module did until #144 — halves
 * the previous pane every time, so seat n lands on 1/2^n of the tab; a measured six-seat crew came up at
 * 51/25/12/6/3/3 percent, its last pane holding about three readable lines.
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

/** Read a nested object field off a herdr result object — the `layout` / `rect` / `area` envelopes. */
const objField = (obj: unknown, key: string): unknown =>
	typeof obj === "object" && obj !== null ? (obj as Record<string, unknown>)[key] : undefined;

/** Read a finite number field off a herdr result object, returning undefined when absent or not a number. */
const numField = (obj: unknown, key: string): number | undefined => {
	const value = objField(obj, key);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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

/** One pane's live rectangle in terminal cells, as `herdr pane layout` reports it. */
export interface HerdrPaneRect {
	readonly paneId: string;
	readonly width: number;
	readonly height: number;
}

/** A tab's geometry: the content area the panes tile, and the panes tiling it. */
export interface HerdrTabLayout {
	readonly width: number;
	readonly height: number;
	readonly panes: readonly HerdrPaneRect[];
}

/** Where the next crew seat goes: which pane it splits, along which axis, and what share that pane keeps. */
export interface HerdrSplitPlan {
	/** The pane to pass to `pane split --pane`. */
	readonly target: string;
	readonly direction: "right" | "down";
	/**
	 * The fraction of the target the TARGET KEEPS — the new pane gets `1 - ratio`. That orientation is
	 * herdr's, measured rather than assumed: `pane split --pane P --direction right --ratio 0.25` on a
	 * 171-column pane leaves P at 43 columns and gives the new pane 128.
	 */
	readonly ratio: number;
}

/**
 * How much taller than wide one terminal cell is, near enough. A pane is readable by its shape ON SCREEN,
 * not in cells: a 193x57 tab is about 1.6:1 to the eye, not 3.4:1. Comparing raw `width` against `height`
 * would therefore call almost every region "wider than tall" and split it `right` again and again, which
 * tiles a six-seat crew into 32-column strips — even in area, useless to read. Cells run about 2:1 in the
 * fonts a terminal renders, so that is the factor the longer axis is judged against.
 */
const CELL_ASPECT = 2;

/**
 * Choose the pane the next crew seat splits, the axis, and the ratio — the entire placement rule, as pure
 * arithmetic over one `pane layout` reading. Returns undefined only for a tab with no panes at all.
 *
 * `crewSize` is how many seats the tab holds once the stand-up finishes, and knowing it is what makes the
 * result EVEN rather than merely non-degenerate. Divide a pane's area by the even share
 * `total / crewSize` and you get the number of seats that pane's region still owes; the pane owing the
 * most is the one to split, and splitting it so it keeps `ceil(k/2) / k` leaves each side owing half the
 * seats and holding half the area. Run for every seat, that lands the whole crew within a rounding cell
 * of `1 / crewSize` each — 2 through 8 seats all come out inside 6% of even.
 *
 * `undefined` crewSize is the `spawn-role` case: one seat added to a tab whose final size nobody knows.
 * The same arithmetic degrades to its `k = 2` case on its own — every pane owes one seat, so the largest
 * is halved. One split cannot resize the panes it does not touch, so that cannot be even; what it does do
 * is bound the spread at 2x instead of letting it halve away.
 */
export const planCrewSplit = (
	layout: HerdrTabLayout,
	crewSize: number | undefined,
): HerdrSplitPlan | undefined => {
	const areaOf = (pane: HerdrPaneRect) => pane.width * pane.height;
	const total =
		layout.width > 0 && layout.height > 0
			? layout.width * layout.height
			: layout.panes.reduce((sum, pane) => sum + areaOf(pane), 0);
	// The even share one seat is owed. Without a crew size there is none, and every pane owes one seat.
	const share = crewSize !== undefined && crewSize > 0 && total > 0 ? total / crewSize : undefined;
	const seatsOwed = (pane: HerdrPaneRect) =>
		share === undefined ? 1 : Math.max(1, Math.round(areaOf(pane) / share));

	let best: {readonly pane: HerdrPaneRect; readonly owed: number} | undefined;
	for (const pane of layout.panes) {
		const owed = seatsOwed(pane);
		if (
			best === undefined ||
			owed > best.owed ||
			// Ties go to the bigger pane, then to the lower pane id — placement must not depend on the
			// order herdr happened to list the tab in.
			(owed === best.owed &&
				(areaOf(pane) > areaOf(best.pane) ||
					(areaOf(pane) === areaOf(best.pane) && pane.paneId < best.pane.paneId)))
		) {
			best = {pane, owed};
		}
	}
	if (best === undefined) return undefined;

	// Never below 2: this seat and the one already sitting in the target both have to fit in it.
	const owed = Math.max(2, best.owed);
	return {
		target: best.pane.paneId,
		direction: best.pane.width >= best.pane.height * CELL_ASPECT ? "right" : "down",
		ratio: Math.ceil(owed / 2) / owed,
	};
};

/**
 * Format a ratio for herdr's `--ratio <FLOAT>`. Four decimals is under a hundredth of a cell on any tab
 * herdr can render, and it keeps `2/3` out of the argv as `0.6667` rather than seventeen digits.
 */
const ratioArg = (ratio: number): string => ratio.toFixed(4);

/**
 * Read the geometry of the tab holding `paneId`. `pane layout` is tab-scoped and keyed by a pane rather
 * than a tab, which is why the caller looks a pane up first. Returns undefined for any answer the split
 * cannot be planned from — the caller falls back rather than failing a launch over a cosmetic query.
 */
const readTabLayout = (
	paneId: string,
	runHerdrCommand: HerdrRunner,
): Effect.Effect<HerdrTabLayout | undefined> =>
	runHerdrCommand(["pane", "layout", "--pane", paneId]).pipe(
		Effect.map((listed) => {
			const result = herdrResult(listed);
			if (result === undefined) return undefined;
			const layout = result["layout"];
			const area = objField(layout, "area");
			const listedPanes = objField(layout, "panes");
			const panes: HerdrPaneRect[] = [];
			for (const pane of Array.isArray(listedPanes) ? (listedPanes as readonly unknown[]) : []) {
				const id = strField(pane, "pane_id");
				const width = numField(objField(pane, "rect"), "width");
				const height = numField(objField(pane, "rect"), "height");
				if (id !== undefined && width !== undefined && height !== undefined) {
					panes.push({paneId: id, width, height});
				}
			}
			if (panes.length === 0) return undefined;
			return {width: numField(area, "width") ?? 0, height: numField(area, "height") ?? 0, panes};
		}),
	);

/** The panes already open in a tab — the handle the layout is read through, and the fail-closed check that one exists. */
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
 * id so every later session splits into exactly that tab; later sessions `pane split` the pane
 * `planCrewSplit` picks, at the ratio it computes, which is what makes the finished tab evenly tiled.
 *
 * Each launch is the two-step herdr shape — create the pane, then `pane run` the command into its shell
 * — and BOTH steps are checked, so a `LaunchedSession` only ever exists for a pane that was created and
 * commanded. The pane is renamed to its roster label so `retire-role` and the operator can both tell
 * the members apart.
 *
 * `crewSize` is how many seats the finished tab holds — `stand-up` knows it, `spawn-role` does not, and
 * `planCrewSplit` documents what each case gets. tmux takes no such argument because `select-layout
 * tiled` re-tiles the whole window from scratch after every split; herdr has no equivalent, so the even
 * share has to be computed before the split rather than restored after it.
 */
export const launchSessionInHerdr = (
	plan: LaunchPlan,
	workspaceId: string,
	intoTab: string | undefined,
	runHerdrCommand: HerdrRunner = runHerdr,
	crewSize?: number,
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
			// Later session: split the pane the placement rule picks, at the ratio it computes — herdr's
			// stand-in for `select-layout tiled` (see `planCrewSplit`).
			const existing = yield* paneIdsInTab(workspaceId, intoTab, runHerdrCommand);
			const anyPane = existing?.[0];
			if (existing === undefined || anyPane === undefined) {
				return yield* Effect.fail(
					new StandUpLaunchError({
						role: session.role,
						pane: paneLabel,
						reason: `no live pane to split in herdr tab "${intoTab}" (no live pane)`,
					}),
				);
			}
			// `pane layout` is keyed by a pane, so any pane of the tab reads the whole tab's geometry.
			const layout = yield* readTabLayout(anyPane, runHerdrCommand);
			const placed = layout === undefined ? undefined : planCrewSplit(layout, crewSize);
			// Geometry is unreadable only if herdr answered `pane list` and then refused `pane layout`.
			// Placement quality is not the launch contract — a crew that comes up unevenly beats a crew
			// that does not come up — so this falls back to the blind pre-#144 heuristic (halve the last
			// pane, alternating the axis against the live pane count) rather than failing the launch.
			const target = placed?.target ?? existing[existing.length - 1] ?? anyPane;
			const split = yield* runHerdrCommand([
				"pane",
				"split",
				"--pane",
				target,
				"--direction",
				placed?.direction ?? (existing.length % 2 === 0 ? "right" : "down"),
				"--ratio",
				ratioArg(placed?.ratio ?? 0.5),
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

		// ── From here a pane EXISTS, and every failure below must take it back down. ──
		//
		// This is where herdr's shape diverges from tmux's and the no-partial-crew contract stops
		// holding by itself. tmux creates a pane and its process in ONE call, so a guarded failure
		// cannot strand anything. herdr splits the topology first and types the command in second, so
		// a failure after the create leaves a pane on the operator's screen hosting an idle shell.
		//
		// Leaving it is not cosmetic damage. A stranded pane's cwd still matches
		// `findCrewPaneIdInHerdr`, so the REAL member becomes unretireable — the lookup finds two and
		// refuses to close ambiguously. And a retried stand-up runs `tab create --label pipeline`
		// unconditionally, so a stranded first session leaves two crew tabs for `resolveCrewTabId` to
		// choose between.
		//
		// `launchFailure` is deliberately not reused below: it appends "(no live pane)", which is the
		// one thing that is false once the create has succeeded.
		const weOpenedTheTab = intoTab === undefined;
		const afterCreate = (run: HerdrRun, what: string): StandUpLaunchError =>
			new StandUpLaunchError({
				role: session.role,
				pane: paneLabel,
				reason: herdrReason(run, `${what} for pane "${paneLabel}"`),
			});

		/**
		 * Undo the create, then report the original failure.
		 *
		 * Best effort by construction: the failure that got us here is the answer, and a cleanup that
		 * itself fails must not replace it. An unsuccessful unwind appends to the reason instead, so a
		 * pane left on screen is named rather than silently abandoned.
		 */
		const unwind = (failure: StandUpLaunchError): Effect.Effect<StandUpLaunchError> =>
			runHerdrCommand(weOpenedTheTab ? ["tab", "close", tabId] : ["pane", "close", paneId]).pipe(
				Effect.map((undone) =>
					undone.spawnError === undefined && undone.code === 0
						? // The unwind succeeded, so the contract every other failure path asserts now holds
							// again — and saying so is what makes this failure indistinguishable from one that
							// never created anything, which is the point of unwinding at all.
							new StandUpLaunchError({
								role: failure.role,
								pane: failure.pane,
								reason: `${failure.reason} (no live pane)`,
							})
						: new StandUpLaunchError({
								role: failure.role,
								pane: failure.pane,
								reason: `${failure.reason}; and the ${weOpenedTheTab ? `tab it opened (${tabId})` : `pane it split (${paneId})`} could not be closed — it is STRANDED in herdr and must be closed by hand before standing up again`,
							}),
				),
			);

		// Label the pane with its roster identity. Cosmetic for the operator, but it is also the handle
		// `retire-role` matches on, so a failure here would leave an unretireable member — fail closed.
		const renamed = yield* runHerdrCommand(["pane", "rename", paneId, paneLabel]);
		if (renamed.spawnError !== undefined || renamed.code !== 0) {
			return yield* Effect.fail(yield* unwind(afterCreate(renamed, "pane rename")));
		}

		// Step two of the herdr launch shape: type `claude <argv>` into the pane's interactive shell.
		// Until this succeeds the pane exists but hosts no session — a half-launch the crew must not count.
		const ran = yield* runHerdrCommand(["pane", "run", paneId, herdrPaneCommand(bind.argv)]);
		if (ran.spawnError !== undefined || ran.code !== 0) {
			return yield* Effect.fail(yield* unwind(afterCreate(ran, "pane run")));
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
		const crewTabs = arrField(result, "tabs")
			.filter((tab) => strField(tab, "label") === CREW_TAB_LABEL)
			.flatMap((tab) => {
				const id = strField(tab, "tab_id");
				return id === undefined ? [] : [id];
			});
		// Two crew tabs is ambiguous, and answering it by taking the first is how a member gets split
		// into a dead one. `tab create --label pipeline` is unconditional, so a stand-up that stranded
		// a tab leaves exactly this state; refuse it the same way the pane lookup refuses an ambiguous
		// match, and name both so the operator can tell which to close.
		if (crewTabs.length > 1) {
			return yield* Effect.fail(
				new CrewWindowNotRunningError({
					targetSession: workspaceId,
					reason: `${crewTabs.length} tabs labelled "${CREW_TAB_LABEL}" in herdr workspace "${workspaceId}" (${crewTabs.join(", ")}) — refusing to guess which is the crew; close the stale one`,
				}),
			);
		}
		const only = crewTabs[0];
		if (only !== undefined) return only;
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
