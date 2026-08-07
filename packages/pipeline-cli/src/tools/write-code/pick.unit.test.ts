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

describe("countFailRounds — reads the round trailer, not the FAIL markers (#21)", () => {
	const c = (body: string) => ({body});

	it("reads the count out of the surviving marker's trailer", () => {
		expect(countFailRounds([c("review-code: FAIL @ abc\n\n<!-- rounds: 2 -->")])).toBe(2);
	});

	it("still reads it after the marker flipped to PASS — the whole point of #21", () => {
		// The upsert overwrites the FAIL with a PASS, so counting FAIL markers reported 0 here.
		expect(countFailRounds([c("review-code: PASS @ abc\n\n<!-- rounds: 2 -->")])).toBe(2);
	});

	it("reports 0 for a first verdict carrying no trailer", () => {
		expect(countFailRounds([c("review-code: FAIL @ abc")])).toBe(0);
	});

	it("scopes to one gate when asked", () => {
		const comments = [
			c("review-code: PASS @ abc\n<!-- rounds: 1 -->"),
			c("review-doc: FAIL @ ghi\n<!-- rounds: 3 -->"),
		];
		expect(countFailRounds(comments, "code")).toBe(1);
		expect(countFailRounds(comments, "doc")).toBe(3);
		expect(countFailRounds(comments)).toBe(3);
	});

	it("ignores a trailer on a comment that is not a verdict marker", () => {
		expect(countFailRounds([c("just a note\n<!-- rounds: 9 -->")])).toBe(0);
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
