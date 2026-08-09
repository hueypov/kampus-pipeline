/**
 * The herdr terminal backend: the second window manager the launcher can place a crew in, pinned
 * against the two properties that make it a DROP-IN for the tmux path rather than a second launch path
 * — the whole crew lands as panes of ONE `pipeline` tab (never a tab per role), and every step is
 * fail-closed, so a `LaunchedSession` only ever exists for a pane that was created, labelled, AND
 * commanded.
 *
 * The two-step launch shape is what these tests mostly guard. herdr splits topology first and runs the
 * command second, so a created-but-never-commanded pane is a half-launch the crew must not count; the
 * "no partial crew" contract therefore has a wider failure surface here than under tmux, and each
 * failing step is pinned individually. The herdr runner is injected throughout, so none of this needs a
 * real herdr server.
 */
import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import {
	closeHerdrPane,
	CREW_TAB_LABEL,
	findCrewPaneIdInHerdr,
	type HerdrRun,
	type HerdrRunner,
	type HerdrPaneRect,
	herdrPaneCommand,
	herdrResult,
	type HerdrTabLayout,
	launchSessionInHerdr,
	planCrewSplit,
	resolveCrewTabId,
	resolveTargetHerdrWorkspace,
} from "./herdr.ts";
import type {LaunchPlan} from "./orchestrate.ts";

/** A successful herdr client run carrying `result` as its JSON response — the shape every read parses. */
const ok = (result: unknown): HerdrRun => ({
	pid: 4242,
	code: 0,
	signal: null,
	stdout: JSON.stringify({id: "cli:test", result}),
	spawnError: undefined,
});

/** A herdr client that exited non-zero — a server-side refusal (herdr writes its error JSON to stderr). */
const failed: HerdrRun = {pid: 4242, code: 1, signal: null, stdout: "", spawnError: undefined};

/** herdr is not installed / not on PATH — the spawn never produced a client at all. */
const absent: HerdrRun = {
	pid: undefined,
	code: null,
	signal: null,
	stdout: "",
	spawnError: "Error: spawn herdr ENOENT",
};

/**
 * A scripted runner: replies in order from `replies` and records the argv of every call, so a test
 * asserts BOTH what herdr was asked to do and how the launcher reacted to each answer.
 */
const scripted = (replies: readonly HerdrRun[]) => {
	const calls: string[][] = [];
	let i = 0;
	const run: HerdrRunner = (args) => {
		calls.push([...args]);
		const reply = replies[i++];
		return Effect.succeed(reply ?? failed);
	};
	return {run, calls};
};

/**
 * A minimal launch plan. `launchSessionInHerdr` reads only the pane label, the bind argv, the session
 * identity, the launch cwd, and the config path, so the fixture supplies exactly those — the full
 * derivation (roster → bind → placement → cwd) is orchestrate.ts's contract and is tested there.
 */
const planFor = (paneLabel: string, cwd: string): LaunchPlan =>
	({
		session: {kind: "bridge", role: "intake-desk", address: "inbox://intake-desk"},
		bind: {argv: ["--name", "intake-desk", "--model", "opus"]},
		placement: {paneLabel, sessionRef: paneLabel, kind: "bridge"},
		cwd,
		crewConfigPath: "/repo/.claude/crew.config.jsonc",
	}) as unknown as LaunchPlan;

const PLAN = planFor("intake-desk", "/repo/.claude/crew-run/run1/intake-desk");

/** A `pane layout` response for a tab: the content area, and each pane as `[id, width, height]` in cells. */
const layoutOk = (
	panes: readonly (readonly [string, number, number])[],
	width = 200,
	height = 60,
): HerdrRun =>
	ok({
		layout: {
			area: {height, width, x: 0, y: 1},
			panes: panes.map(([pane_id, w, h]) => ({pane_id, rect: {height: h, width: w, x: 0, y: 1}})),
			tab_id: "w1:t5",
		},
	});

/** A tab holding one pane per entry, for driving `planCrewSplit` directly. */
const tab = (
	panes: readonly (readonly [string, number, number])[],
	width = 200,
	height = 60,
): HerdrTabLayout => ({
	width,
	height,
	panes: panes.map(([paneId, w, h]) => ({paneId, width: w, height: h})),
});

/**
 * Replay a whole stand-up's placement and return the tab it leaves behind.
 *
 * The split arithmetic is herdr's own, measured against a live server rather than assumed: `pane split
 * --pane P --direction right --ratio 0.25` on a 171-column pane leaves P at 43 columns (`round(171 *
 * 0.25)`) and gives the NEW pane the remaining 128. So the ratio is the share the target keeps, the
 * extent is rounded to whole cells, and the other axis is untouched.
 */
const tileCrew = (crewSize: number, width: number, height: number): readonly HerdrPaneRect[] => {
	let panes: readonly HerdrPaneRect[] = [{paneId: "p1", width, height}];
	for (let seat = 2; seat <= crewSize; seat++) {
		const split = planCrewSplit({width, height, panes}, crewSize);
		if (split === undefined) throw new Error("a tab with panes always plans a split");
		const target = panes.find((pane) => pane.paneId === split.target);
		if (target === undefined) throw new Error(`planned a split of absent pane ${split.target}`);
		const along = split.direction === "right" ? target.width : target.height;
		const kept = Math.round(along * split.ratio);
		const sized = (id: string, extent: number): HerdrPaneRect =>
			split.direction === "right"
				? {paneId: id, width: extent, height: target.height}
				: {paneId: id, width: target.width, height: extent};
		panes = [
			...panes.filter((pane) => pane !== target),
			sized(target.paneId, kept),
			sized(`p${seat}`, along - kept),
		];
	}
	return panes;
};

/** Each pane's share of the tab, as a fraction — the units issue #144 measured the defect in. */
const shares = (panes: readonly HerdrPaneRect[], width: number, height: number): readonly number[] =>
	panes.map((pane) => (pane.width * pane.height) / (width * height));

describe("standup/herdr — placing a seat (pure geometry)", () => {
	it("splits the pane owing the most seats, never the newest one", () => {
		// The #144 defect in one assertion: `existing.at(-1)` split the pane added last, so each seat
		// halved the one before it and pane n landed on 1/2^n of the tab.
		const split = planCrewSplit(tab([["p1", 200, 30], ["p2", 100, 30], ["p3", 100, 30]]), 4);
		assert.strictEqual(split?.target, "p1", "the half-tab pane still owes two seats; the quarters owe one");
	});

	it("keeps the target the share its remaining seats are worth", () => {
		// A pane owing 3 of a 6-seat tab keeps 2 of those 3 and hands 1 to the new pane, so both sides
		// come out owing a whole number of seats at exactly the even area.
		const owing3 = planCrewSplit(tab([["p1", 100, 60], ["p2", 100, 60]], 200, 60), 6);
		assert.closeTo(owing3?.ratio ?? 0, 2 / 3, 1e-9);

		const owing2 = planCrewSplit(tab([["p1", 100, 60], ["p2", 50, 60], ["p3", 50, 60]], 200, 60), 4);
		assert.closeTo(owing2?.ratio ?? 0, 0.5, 1e-9, "a pane owing two seats is halved");
	});

	it("halves the largest pane when the crew size is unknown — the spawn-role case", () => {
		const split = planCrewSplit(tab([["p1", 120, 60], ["p2", 80, 60]]), undefined);
		assert.deepStrictEqual(
			{target: split?.target, ratio: split?.ratio},
			{target: "p1", ratio: 0.5},
			"nothing says how many seats are still coming, so the biggest pane is halved",
		);
	});

	it("splits the longer axis ON SCREEN, counting a cell as twice as tall as it is wide", () => {
		// 100x60 cells is about 800x1020 pixels — taller than it is wide, however the raw numbers read.
		// Comparing width against height alone would answer "right" here, and answering "right" every
		// time is what tiles a six-seat crew into 32-column strips.
		assert.strictEqual(planCrewSplit(tab([["p1", 100, 60]], 100, 60), 2)?.direction, "down");
		assert.strictEqual(planCrewSplit(tab([["p1", 100, 40]], 100, 40), 2)?.direction, "right");
	});

	it("breaks a tie on pane id so placement does not depend on herdr's listing order", () => {
		const listed = planCrewSplit(tab([["p2", 100, 60], ["p1", 100, 60]], 200, 60), 4);
		const reversed = planCrewSplit(tab([["p1", 100, 60], ["p2", 100, 60]], 200, 60), 4);
		assert.strictEqual(listed?.target, "p1");
		assert.deepStrictEqual(listed, reversed);
	});

	it("plans nothing for a tab with no panes", () => {
		assert.isUndefined(planCrewSplit(tab([]), 4));
	});
});

describe("standup/herdr — the tab a whole stand-up leaves behind", () => {
	it("tiles 2 through 8 seats to within a rounding cell of even", () => {
		for (let crewSize = 2; crewSize <= 8; crewSize++) {
			const panes = tileCrew(crewSize, 193, 57);
			assert.lengthOf(panes, crewSize, `${crewSize} seats produce ${crewSize} panes`);
			const even = 1 / crewSize;
			for (const share of shares(panes, 193, 57)) {
				// Whole cells cannot divide evenly at every count, so the tolerance is the rounding, not
				// the rule: every measured layout lands inside 4% of even, and 7% leaves headroom.
				assert.closeTo(
					share,
					even,
					even * 0.07,
					`${crewSize} seats: ${shares(panes, 193, 57).map((s) => `${(s * 100).toFixed(1)}%`).join(" ")}`,
				);
			}
		}
	});

	it("keeps every pane big enough to read, rather than only equal in area", () => {
		// Equal area is not sufficient: splitting the longer axis by raw cell counts tiles six seats into
		// six full-height 32-column strips — dead even, and too narrow to read wrapped output in.
		for (let crewSize = 2; crewSize <= 8; crewSize++) {
			for (const pane of tileCrew(crewSize, 193, 57)) {
				assert.isAtLeast(pane.width, 36, `${crewSize} seats left a ${pane.width}-column pane`);
				assert.isAtLeast(pane.height, 18, `${crewSize} seats left a ${pane.height}-row pane`);
			}
		}
	});

	it("re-tiles the six-seat crew #144 measured at 51/25/12/6/3/3 percent", () => {
		// The live measurement on a 193x57 tab: chief-of-staff took half the tab and the cartographer
		// pane held about three readable lines. Nothing here may come out under a tenth of the tab.
		const measured = shares(tileCrew(6, 193, 57), 193, 57);
		assert.isAbove(Math.min(...measured), 0.15, "the smallest seat was 3% of the tab before this");
		assert.isBelow(Math.max(...measured), 0.19, "the largest was 51%");
	});
});

describe("standup/herdr — reading the CLI's JSON responses", () => {
	it("reads the `result` object off a successful run", () => {
		assert.deepStrictEqual(herdrResult(ok({tab: {tab_id: "w1:t2"}})), {tab: {tab_id: "w1:t2"}});
	});

	it("collapses a non-zero exit, a spawn failure, and unparseable stdout to one 'no result' signal", () => {
		assert.isUndefined(herdrResult(failed), "a non-zero exit has no usable result");
		assert.isUndefined(herdrResult(absent), "an absent herdr binary has no usable result");
		assert.isUndefined(
			herdrResult({...ok({}), stdout: "not json"}),
			"unparseable stdout has no usable result",
		);
	});
});

describe("standup/herdr — the pane command", () => {
	it("single-quotes every token so the pane's shell re-parses the argv verbatim", () => {
		assert.strictEqual(
			herdrPaneCommand(["--name", "engineering-manager-1"]),
			"'claude' '--name' 'engineering-manager-1'",
		);
	});

	it("escapes an embedded single quote rather than breaking out of the quoting", () => {
		assert.strictEqual(herdrPaneCommand(["it's"]), "'claude' 'it'\\''s'");
	});
});

describe("standup/herdr — resolving the target workspace", () => {
	it.effect("adopts the caller's own workspace when running inside a herdr pane", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([]);
			const ws = yield* resolveTargetHerdrWorkspace({HERDR_WORKSPACE_ID: "w7"}, run);
			assert.strictEqual(ws, "w7", "the crew is placed where the operator already is");
			assert.lengthOf(calls, 0, "no probe is needed when herdr injected the workspace");
		}),
	);

	it.effect("falls back to the first open workspace when run outside herdr", () =>
		Effect.gen(function* () {
			const {run} = scripted([ok({workspaces: [{workspace_id: "w2"}, {workspace_id: "w3"}]})]);
			assert.strictEqual(yield* resolveTargetHerdrWorkspace({}, run), "w2");
		}),
	);

	it.effect("creates a workspace only when herdr has none open at all", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([ok({workspaces: []}), ok({workspace: {workspace_id: "w9"}})]);
			assert.strictEqual(yield* resolveTargetHerdrWorkspace({}, run), "w9");
			assert.deepStrictEqual(calls[1], ["workspace", "create", "--label", "crew"]);
		}),
	);

	it.effect("fails closed, naming the missing binary, when herdr is not installed", () =>
		Effect.gen(function* () {
			const {run} = scripted([absent]);
			const error = yield* Effect.flip(resolveTargetHerdrWorkspace({}, run));
			assert.include(error.reason, "is herdr installed and on PATH?");
		}),
	);
});

describe("standup/herdr — launching the crew into ONE tab", () => {
	it.effect("opens the `pipeline` tab for the first session, in that pane's own launch cwd", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([
				ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}),
				ok({}),
				ok({}),
			]);
			const launched = yield* launchSessionInHerdr(PLAN, "w1", undefined, run);

			const create = calls[0] ?? [];
			assert.deepStrictEqual(create.slice(0, 2), ["tab", "create"]);
			assert.include(create, CREW_TAB_LABEL, "the tab is labelled for the pipeline it runs");
			assert.include(create, "/repo/.claude/crew-run/run1/intake-desk");
			assert.include(
				create,
				"CREW_CONFIG=/repo/.claude/crew.config.jsonc",
				"the pane inherits the config the launcher validated",
			);
			assert.strictEqual(launched.window, "w1:t5", "the tab id threads into every later session");
			assert.strictEqual(launched.pane, "intake-desk");
		}),
	);

	it.effect("splits a pane into the SAME tab for later sessions — never a second tab", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([
				ok({panes: [{pane_id: "w1:p8", tab_id: "w1:t5"}]}),
				layoutOk([["w1:p8", 200, 60]]),
				ok({pane: {pane_id: "w1:p9"}}),
				ok({}),
				ok({}),
			]);
			const launched = yield* launchSessionInHerdr(
				planFor("cartographer", "/repo/.claude/crew-run/run1/cartographer"),
				"w1",
				"w1:t5",
				run,
			);

			assert.isUndefined(
				calls.find((c) => c[0] === "tab" && c[1] === "create"),
				"a later session must not create a tab of its own",
			);
			const split = calls[2] ?? [];
			assert.deepStrictEqual(split.slice(0, 2), ["pane", "split"]);
			assert.include(split, "w1:p8", "it splits a pane that already lives in the crew tab");
			assert.include(split, "--no-focus", "adding a member must not steal the operator's focus");
			assert.strictEqual(launched.window, "w1:t5", "the crew stays in one tab");
		}),
	);

	/** Run one later-session launch against a scripted tab geometry and return the `pane split` argv. */
	const splitArgvFor = (
		panes: readonly (readonly [string, number, number])[],
		crewSize: number | undefined,
		layout: HerdrRun = layoutOk(panes),
	) =>
		Effect.gen(function* () {
			const {run, calls} = scripted([
				ok({panes: panes.map(([pane_id]) => ({pane_id, tab_id: "w1:t5"}))}),
				layout,
				ok({pane: {pane_id: "w1:pn"}}),
				ok({}),
				ok({}),
			]);
			yield* launchSessionInHerdr(PLAN, "w1", "w1:t5", run, crewSize);
			return {argv: calls[2] ?? [], calls};
		});

	/** Read one flag's value out of a `pane split` argv. */
	const flag = (argv: readonly string[], name: string) => argv[argv.indexOf(name) + 1];

	it.effect("splits the pane the placement rule picks, at the ratio it computes", () =>
		Effect.gen(function* () {
			// Three seats of six placed: the pane still owing three is the one to split, and it keeps
			// two of those three. Splitting the newest at herdr's default 50/50 is what put six seats on
			// 51/25/12/6/3/3 of a tab (#144).
			const {argv} = yield* splitArgvFor(
				[
					["w1:p8", 96, 57],
					["w1:p9", 64, 57],
					["w1:p10", 33, 57],
				],
				6,
				layoutOk(
					[
						["w1:p8", 96, 57],
						["w1:p9", 64, 57],
						["w1:p10", 33, 57],
					],
					193,
					57,
				),
			);
			assert.deepStrictEqual(argv.slice(0, 2), ["pane", "split"]);
			assert.strictEqual(flag(argv, "--pane"), "w1:p8", "the pane owing the most seats, not the last");
			assert.strictEqual(flag(argv, "--ratio"), "0.6667", "it keeps two of the three seats it owes");
		}),
	);

	it.effect("passes an explicit ratio rather than leaning on herdr's 50/50 default", () =>
		Effect.gen(function* () {
			const {argv} = yield* splitArgvFor([["w1:p8", 200, 60]], 4);
			assert.include(argv, "--ratio", "an unpassed ratio is a 50/50 split, whatever the seat count");
			assert.strictEqual(flag(argv, "--ratio"), "0.5000", "a pane owing four seats keeps two");
		}),
	);

	it.effect("splits the longer axis on screen, so panes do not degenerate into narrow columns", () =>
		Effect.gen(function* () {
			const wide = yield* splitArgvFor([["w1:p8", 200, 40]], 2);
			assert.strictEqual(flag(wide.argv, "--direction"), "right");
			const tall = yield* splitArgvFor([["w1:p8", 100, 60]], 2);
			assert.strictEqual(flag(tall.argv, "--direction"), "down");
		}),
	);

	it.effect("still splits, halving the last pane, when herdr will not report the geometry", () =>
		Effect.gen(function* () {
			// Placement quality is not the launch contract: a crew that comes up unevenly beats a crew
			// that does not come up, so an unreadable layout degrades rather than failing the stand-up.
			const {argv} = yield* splitArgvFor(
				[
					["w1:p8", 200, 60],
					["w1:p9", 100, 60],
				],
				4,
				failed,
			);
			assert.deepStrictEqual(argv.slice(0, 2), ["pane", "split"]);
			assert.strictEqual(flag(argv, "--pane"), "w1:p9", "the blind pre-#144 heuristic: the last pane");
			assert.strictEqual(flag(argv, "--direction"), "right", "alternating against the live pane count");
			assert.strictEqual(flag(argv, "--ratio"), "0.5000");
		}),
	);

	it.effect("labels the pane with its roster identity so members stay tellable apart", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([
				ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}),
				ok({}),
				ok({}),
			]);
			yield* launchSessionInHerdr(PLAN, "w1", undefined, run);
			assert.deepStrictEqual(calls[1], ["pane", "rename", "w1:p8", "intake-desk"]);
		}),
	);

	it.effect("runs `claude` into the created pane as the second half of the launch", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([
				ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}),
				ok({}),
				ok({}),
			]);
			yield* launchSessionInHerdr(PLAN, "w1", undefined, run);
			assert.deepStrictEqual(calls[2], [
				"pane",
				"run",
				"w1:p8",
				"'claude' '--name' 'intake-desk' '--model' 'opus'",
			]);
		}),
	);

	it.effect("fails closed when the tab never comes up — no LaunchedSession for a dead pane", () =>
		Effect.gen(function* () {
			const {run} = scripted([failed]);
			const error = yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", undefined, run));
			assert.strictEqual(error.role, "intake-desk");
			assert.strictEqual(error.pane, "intake-desk");
			assert.include(error.reason, "no live pane");
		}),
	);

	it.effect("closes the tab it opened when the command never ran (the half-launch)", () =>
		Effect.gen(function* () {
			// The bug this exists for: every error path was checked and NONE cleaned up, so a failure
			// here left a focused `pipeline` tab hosting an idle shell. That is not cosmetic — the
			// stranded pane's cwd still matches the retire lookup, making the real member unretireable,
			// and the next stand-up adds a second crew tab.
			const {run, calls} = scripted([
				ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}),
				ok({}),
				failed,
				ok({}),
			]);
			const error = yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", undefined, run));
			assert.include(error.reason, "pane run");
			assert.deepStrictEqual(calls.at(-1), ["tab", "close", "w1:t5"], "the tab it opened is closed");
			assert.include(error.reason, "no live pane", "and the contract holds again once it is");
		}),
	);

	it.effect("closes only the pane it split when a later session half-launches", () =>
		Effect.gen(function* () {
			// A later member must not take the whole crew tab down with it — the other members are in it.
			const {run, calls} = scripted([ok({panes: [{pane_id: "w1:p8", tab_id: "w1:t5"}]}), layoutOk([["w1:p8", 200, 60]]), ok({pane: {pane_id: "w1:p9"}}), ok({}), failed, ok({})]);
			yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", "w1:t5", run));
			assert.deepStrictEqual(calls.at(-1), ["pane", "close", "w1:p9"]);
		}),
	);

	it.effect("unwinds a failed rename too, not only a failed run", () =>
		Effect.gen(function* () {
			const {run, calls} = scripted([ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}), failed, ok({})]);
			const error = yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", undefined, run));
			assert.include(error.reason, "pane rename");
			assert.deepStrictEqual(calls.at(-1), ["tab", "close", "w1:t5"]);
		}),
	);

	it.effect("names the stranded tab when the unwind itself fails", () =>
		Effect.gen(function* () {
			// Best effort: the original failure still surfaces, but a pane left on screen is named
			// rather than silently abandoned.
			const {run} = scripted([ok({tab: {tab_id: "w1:t5"}, root_pane: {pane_id: "w1:p8"}}), ok({}), failed, failed]);
			const error = yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", undefined, run));
			assert.include(error.reason, "pane run", "the original failure is still the answer");
			assert.include(error.reason, "STRANDED");
			assert.include(error.reason, "w1:t5");
			assert.notInclude(error.reason, "no live pane", "because there is one");
		}),
	);

	it.effect("fails closed when the crew tab holds no pane to split", () =>
		Effect.gen(function* () {
			const {run} = scripted([ok({panes: []})]);
			const error = yield* Effect.flip(launchSessionInHerdr(PLAN, "w1", "w1:t5", run));
			assert.include(error.reason, "no live pane");
		}),
	);
});

describe("standup/herdr — finding the running crew again", () => {
	it.effect("resolves the `pipeline` tab id for spawn-role to split into", () =>
		Effect.gen(function* () {
			const {run} = scripted([
				ok({tabs: [{tab_id: "w1:t1", label: "1"}, {tab_id: "w1:t5", label: CREW_TAB_LABEL}]}),
			]);
			assert.strictEqual(yield* resolveCrewTabId("w1", run), "w1:t5");
		}),
	);

	it.effect("fails closed telling the operator to stand up first when no crew tab is open", () =>
		Effect.gen(function* () {
			const {run} = scripted([ok({tabs: [{tab_id: "w1:t1", label: "1"}]})]);
			const error = yield* Effect.flip(resolveCrewTabId("w1", run));
			assert.include(error.reason, "run stand-up first");
		}),
	);

	it.effect("refuses to guess between two crew tabs rather than taking the first", () =>
		Effect.gen(function* () {
			// Taking the first is how spawn-role splits a member into a dead tab. `tab create --label
			// pipeline` is unconditional, so any stranded stand-up leaves exactly this state; both ids
			// are named so the operator can tell which to close.
			const {run} = scripted([
				ok({tabs: [{tab_id: "w1:t5", label: CREW_TAB_LABEL}, {tab_id: "w1:t9", label: CREW_TAB_LABEL}]}),
			]);
			const error = yield* Effect.flip(resolveCrewTabId("w1", run));
			assert.include(error.reason, "refusing to guess");
			assert.include(error.reason, "w1:t5");
			assert.include(error.reason, "w1:t9");
		}),
	);

	it.effect("identifies a member by its distinct launcher-owned cwd", () =>
		Effect.gen(function* () {
			const {run} = scripted([
				ok({
					panes: [
						{pane_id: "w1:p1", cwd: "/repo"},
						{pane_id: "w1:p8", cwd: "/repo/.claude/crew-run/run1/intake-desk"},
						{pane_id: "w1:p9", cwd: "/repo/.claude/crew-run/run1/cartographer"},
					],
				}),
			]);
			assert.strictEqual(yield* findCrewPaneIdInHerdr("intake-desk", "intake-desk", run), "w1:p8");
		}),
	);

	it.effect("refuses to close ambiguously — zero matches and many matches both fail closed", () =>
		Effect.gen(function* () {
			const none = scripted([ok({panes: [{pane_id: "w1:p1", cwd: "/repo"}]})]);
			const gone = yield* Effect.flip(findCrewPaneIdInHerdr("intake-desk", "intake-desk", none.run));
			assert.strictEqual(gone.matched, 0);
			assert.include(gone.reason, "already retired");

			const many = scripted([
				ok({
					panes: [
						{pane_id: "w1:p8", cwd: "/repo/.claude/crew-run/run1/intake-desk"},
						{pane_id: "w1:p9", cwd: "/repo/.claude/crew-run/run2/intake-desk"},
					],
				}),
			]);
			const ambiguous = yield* Effect.flip(
				findCrewPaneIdInHerdr("intake-desk", "intake-desk", many.run),
			);
			assert.strictEqual(ambiguous.matched, 2);
			assert.include(ambiguous.reason, "refusing to close ambiguously");
		}),
	);

	it.effect("fails closed rather than half-tearing-down when the pane will not close", () =>
		Effect.gen(function* () {
			const {run} = scripted([failed]);
			const error = yield* Effect.flip(closeHerdrPane("w1:p8", run));
			assert.strictEqual(error.paneId, "w1:p8");
		}),
	);
});
