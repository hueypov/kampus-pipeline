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
	herdrPaneCommand,
	herdrResult,
	launchSessionInHerdr,
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
			const split = calls[1] ?? [];
			assert.deepStrictEqual(split.slice(0, 2), ["pane", "split"]);
			assert.include(split, "w1:p8", "it splits a pane that already lives in the crew tab");
			assert.include(split, "--no-focus", "adding a member must not steal the operator's focus");
			assert.strictEqual(launched.window, "w1:t5", "the crew stays in one tab");
		}),
	);

	it.effect("alternates split direction so panes do not degenerate into narrow columns", () =>
		Effect.gen(function* () {
			const dirFor = (paneCount: number) =>
				Effect.gen(function* () {
					const panes = Array.from({length: paneCount}, (_, i) => ({
						pane_id: `w1:p${i}`,
						tab_id: "w1:t5",
					}));
					const {run, calls} = scripted([
						ok({panes}),
						ok({pane: {pane_id: "w1:pn"}}),
						ok({}),
						ok({}),
					]);
					yield* launchSessionInHerdr(PLAN, "w1", "w1:t5", run);
					const split = calls[1] ?? [];
					return split[split.indexOf("--direction") + 1];
				});

			assert.strictEqual(yield* dirFor(2), "right");
			assert.strictEqual(yield* dirFor(3), "down");
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
			const {run, calls} = scripted([ok({panes: [{pane_id: "w1:p8", tab_id: "w1:t5"}]}), ok({pane: {pane_id: "w1:p9"}}), ok({}), failed, ok({})]);
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
