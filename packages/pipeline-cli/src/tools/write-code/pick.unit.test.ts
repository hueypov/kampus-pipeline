/**
 * Unit tests for the `write-code` pure core: candidate ordering, the closing reference, and the
 * repair-round count. IO-free.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type Candidate,
	capState,
	closesIssue,
	composePrBody,
	countFailRounds,
	rankCandidates,
} from "./pick.ts";

const row = (
	number: number,
	labels: ReadonlyArray<string>,
	createdAt = "2026-08-01T00:00:00Z",
): Candidate => ({number, title: `#${number}`, labels, createdAt});

describe("rankCandidates", () => {
	it("orders by band, then oldest, then number", () => {
		const rows = [
			row(3, ["p2", "ready-for:agent"], "2026-08-01T00:00:00Z"),
			row(1, ["p0", "ready-for:agent"], "2026-08-05T00:00:00Z"),
			row(2, ["p1", "ready-for:agent"], "2026-08-02T00:00:00Z"),
		];
		expect(rankCandidates({rows, readyFor: "agent"}).map((r) => r.number)).toEqual([1, 2, 3]);
	});

	it("breaks a same-band same-timestamp tie on number, so the pick is total", () => {
		const t = "2026-08-01T00:00:00Z";
		const rows = [row(9, ["p1", "ready-for:agent"], t), row(4, ["p1", "ready-for:agent"], t)];
		expect(rankCandidates({rows, readyFor: "agent"}).map((r) => r.number)).toEqual([4, 9]);
	});

	it("never surfaces work addressed to a human", () => {
		const rows = [row(1, ["p0", "ready-for:human"]), row(2, ["p2", "ready-for:agent"])];
		expect(rankCandidates({rows, readyFor: "agent"}).map((r) => r.number)).toEqual([2]);
	});

	it("excludes an issue with NO audience label — an unstated audience is not an implied one", () => {
		const rows = [row(1, ["p0"]), row(2, ["p2", "ready-for:agent"])];
		expect(rankCandidates({rows, readyFor: "agent"}).map((r) => r.number)).toEqual([2]);
	});

	it("includes unlabelled work only under `any`", () => {
		const rows = [row(1, ["p0"]), row(2, ["p2", "ready-for:human"])];
		expect(rankCandidates({rows, readyFor: "any"}).map((r) => r.number)).toEqual([1, 2]);
	});

	it("sorts an unrecognised band last rather than crashing", () => {
		const rows = [row(1, ["p9", "ready-for:agent"]), row(2, ["p2", "ready-for:agent"])];
		expect(rankCandidates({rows, readyFor: "agent"}).map((r) => r.number)).toEqual([2, 1]);
	});
});

describe("closing reference", () => {
	it("composes the body with the reference on its own line", () => {
		expect(composePrBody("Did the thing.\n\n", 412)).toBe("Did the thing.\n\nFixes #412\n");
	});

	it.each(["Fixes #412", "closes #412", "RESOLVES #412"])("recognises %s", (ref) => {
		expect(closesIssue(`blah\n\n${ref}\n`, 412)).toBe(true);
	});

	it("does not match a different issue number", () => {
		expect(closesIssue("Fixes #4120", 412)).toBe(false);
		expect(closesIssue("Fixes #41", 412)).toBe(false);
	});

	it("does not match a bare mention with no closing keyword", () => {
		expect(closesIssue("related to #412", 412)).toBe(false);
	});
});

describe("countFailRounds", () => {
	const c = (body: string) => ({body});

	it("counts one round per FAIL marker across gates", () => {
		expect(
			countFailRounds([
				c("review-code: FAIL @ abc"),
				c("review-code: PASS @ def"),
				c("review-doc: FAIL @ ghi"),
			]),
		).toBe(2);
	});

	it("scopes to one gate when asked", () => {
		expect(
			countFailRounds([c("review-code: FAIL @ abc"), c("review-doc: FAIL @ ghi")], "code"),
		).toBe(1);
	});

	it("tolerates the emphasised marker form", () => {
		expect(countFailRounds([c("**review-code: FAIL** @ abc")])).toBe(1);
	});

	it("does not count a marker merely quoted mid-sentence", () => {
		expect(countFailRounds([c("the gate posts `review-code: FAIL` when it refuses")])).toBe(0);
	});
});

describe("capState", () => {
	it("permits another round below the cap and stops at or over it", () => {
		expect(capState(0, 2)).toBe("under");
		expect(capState(1, 2)).toBe("under");
		expect(capState(2, 2)).toBe("at");
		expect(capState(3, 2)).toBe("over");
	});
});
