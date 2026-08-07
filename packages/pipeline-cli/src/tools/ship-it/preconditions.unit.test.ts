/**
 * Unit tests for the `ship-it` pure core: the exit table and the precondition decisions. IO-free.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	checksPrecondition,
	EXIT,
	firstRefusal,
	gatePrecondition,
	mergeablePrecondition,
	ok,
	refused,
} from "./preconditions.ts";

describe("gatePrecondition", () => {
	it("passes only a current-head PASS", () => {
		expect(gatePrecondition("code", {_tag: "pass", sha: "30e98f4c69fe"}).ok).toBe(true);
	});

	it.each([
		[{_tag: "fail"} as const, EXIT.VERDICT_FAIL],
		[{_tag: "stale", sha: "e1db540e"} as const, EXIT.VERDICT_STALE],
		[{_tag: "none"} as const, EXIT.NO_VERDICT],
		[{_tag: "unknown", reason: "gh exited 1"} as const, EXIT.PRECONDITION_UNKNOWN],
	])("refuses %s with its own code", (state, code) => {
		const p = gatePrecondition("code", state);
		expect(p.ok).toBe(false);
		expect(p.ok === false && p.code).toBe(code);
	});

	it("gives a stale verdict a different code from a failing one — different owners", () => {
		// stale → the reviewer must re-run; fail → the author must repair. Fusing them would send
		// one of them to the wrong stage.
		const stale = gatePrecondition("code", {_tag: "stale", sha: "abc1234"});
		const fail = gatePrecondition("code", {_tag: "fail"});
		expect(stale.ok === false && stale.code).not.toBe(fail.ok === false && fail.code);
	});
});

describe("checksPrecondition", () => {
	it("passes when checks reported and all passed", () => {
		expect(checksPrecondition({state: "green", failing: [], pending: []}).ok).toBe(true);
	});

	it("separates red from pending, because their owners differ", () => {
		const red = checksPrecondition({state: "red", failing: ["ci"], pending: []});
		const pending = checksPrecondition({state: "pending", failing: [], pending: ["ci"]});
		expect(red.ok === false && red.code).toBe(EXIT.CHECKS_RED);
		expect(pending.ok === false && pending.code).toBe(EXIT.CHECKS_PENDING);
	});

	it("treats NO checks as unknown, never as green", () => {
		// This is the vacuous-pass hole: a repository with no CI would otherwise merge on a gate
		// that confirmed nothing.
		const none = checksPrecondition({state: "none", failing: [], pending: []});
		expect(none.ok).toBe(false);
		expect(none.ok === false && none.code).toBe(EXIT.PRECONDITION_UNKNOWN);
	});
});

describe("mergeablePrecondition", () => {
	const base = {state: "open", draft: false, merged: false, mergeableState: "clean"};

	it("passes a clean open PR", () => {
		expect(mergeablePrecondition(base).ok).toBe(true);
	});

	it.each([
		[{...base, merged: true}, "already merged"],
		[{...base, state: "closed"}, "state is closed"],
		[{...base, draft: true}, "still a draft"],
		[{...base, mergeableState: "dirty"}, "conflicts with the base"],
	])("refuses %o", (pr, detail) => {
		const p = mergeablePrecondition(pr);
		expect(p.ok).toBe(false);
		expect(p.ok === false && p.code).toBe(EXIT.NOT_MERGEABLE);
		expect(p.detail).toBe(detail);
	});

	it("does not refuse an unknown mergeable_state — only a proven-dirty one", () => {
		// GitHub reports null while it computes mergeability; refusing on that would make the verb
		// flaky rather than safe.
		expect(mergeablePrecondition({...base, mergeableState: null}).ok).toBe(true);
	});
});

describe("firstRefusal", () => {
	it("returns null when everything passed", () => {
		expect(firstRefusal([ok("a", "-"), ok("b", "-")])).toBeNull();
	});

	it("reports one owner at a time, in evaluation order", () => {
		const r = firstRefusal([
			ok("gate", "-"),
			refused("checks", EXIT.CHECKS_RED, "failing"),
			refused("mergeable", EXIT.NOT_MERGEABLE, "dirty"),
		]);
		expect(r?.name).toBe("checks");
		expect(r?.code).toBe(EXIT.CHECKS_RED);
	});
});
