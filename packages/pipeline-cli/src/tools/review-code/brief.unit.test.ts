/**
 * Unit tests for the `review-code brief` pure core: the closing reference and the criteria parse.
 * IO-free.
 */
import {describe, expect, it} from "@effect/vitest";
import {acceptanceCriteria, closedIssue, renderBrief} from "./brief.ts";

describe("closedIssue", () => {
	it.each(["Fixes #412", "closes #412", "RESOLVED #412", "fixed #412"])("recognises %s", (ref) => {
		expect(closedIssue(`blah\n\n${ref}\n`)).toBe(412);
	});

	it("does not treat a bare mention as a close", () => {
		// Grading a PR against an issue nobody linked it to is worse than refusing to grade it.
		expect(closedIssue("related to #412")).toBeNull();
		expect(closedIssue("see #412 for context")).toBeNull();
	});

	it("does not match a longer number", () => {
		expect(closedIssue("Fixes #4120")).toBe(4120);
		expect(closedIssue("Fixes #4120")).not.toBe(412);
	});

	it("returns null when there is no reference at all", () => {
		expect(closedIssue("just a description")).toBeNull();
	});
});

describe("acceptanceCriteria", () => {
	const body = [
		"## Problem",
		"It breaks.",
		"",
		"## Acceptance criteria",
		"",
		"- [ ] the hook resolves at run time",
		"- [x] a failure is loud",
		"",
		"## Triage note",
		"- [ ] this is not a criterion",
	].join("\n");

	it("reads the checkbox items in the section", () => {
		expect(acceptanceCriteria(body)).toEqual([
			"the hook resolves at run time",
			"a failure is loud",
		]);
	});

	it("stops at the next heading — items below are not criteria", () => {
		expect(acceptanceCriteria(body)).not.toContain("this is not a criterion");
	});

	it("returns null when there is no criteria section", () => {
		expect(acceptanceCriteria("## Problem\nno criteria here")).toBeNull();
	});

	it("distinguishes an EMPTY section from a missing one", () => {
		// Both refuse, but only one means somebody wrote the heading and stopped — and an empty
		// list would otherwise let a PASS be earned by satisfying nothing.
		expect(acceptanceCriteria("## Acceptance criteria\n\n## Next")).toEqual([]);
		expect(acceptanceCriteria("## Next")).toBeNull();
	});

	it("ignores prose inside the section that is not a checkbox item", () => {
		const b = "## Acceptance criteria\n\nSome framing.\n\n- [ ] the real one\n";
		expect(acceptanceCriteria(b)).toEqual(["the real one"]);
	});

	it("is case-insensitive on the heading", () => {
		expect(acceptanceCriteria("## ACCEPTANCE CRITERIA\n- [ ] x")).toEqual(["x"]);
	});

	it("folds a wrapped criterion back into one, rather than truncating it", () => {
		// The defect: only the first line was captured, so a reviewer graded half a sentence with
		// nothing to indicate the rest existed. Reproduced from issue #44's real body.
		const b = [
			"## Acceptance criteria",
			"",
			"- [ ] a child with no acceptance criterion, no spec section, or no story trace is refused, each with",
			"      its own exit code",
			"- [ ] filing the same child twice reuses the first rather than creating a twin",
		].join("\n");
		expect(acceptanceCriteria(b)).toEqual([
			"a child with no acceptance criterion, no spec section, or no story trace is refused, each with its own exit code",
			"filing the same child twice reuses the first rather than creating a twin",
		]);
	});

	it("folds a criterion wrapped across three lines", () => {
		const b = "## Acceptance criteria\n- [ ] one\n  two\n  three\n";
		expect(acceptanceCriteria(b)).toEqual(["one two three"]);
	});

	it("does not fold a following paragraph separated by a blank line", () => {
		// A blank line ends the item, exactly as the renderer reads it.
		const b = "## Acceptance criteria\n- [ ] the criterion\n\nAn unrelated note.\n";
		expect(acceptanceCriteria(b)).toEqual(["the criterion"]);
	});

	it("does not fold prose that precedes the first item", () => {
		const b = "## Acceptance criteria\n\nSome framing.\n\n- [ ] the real one\n";
		expect(acceptanceCriteria(b)).toEqual(["the real one"]);
	});

	it("does not fold a sub-heading into the criterion above it", () => {
		const b = "## Acceptance criteria\n- [ ] the criterion\n### Notes\nprose\n";
		expect(acceptanceCriteria(b)).toEqual(["the criterion"]);
	});

	it("still drops an item whose text is empty even after folding", () => {
		expect(acceptanceCriteria("## Acceptance criteria\n- [ ] \n\n- [ ] real\n")).toEqual(["real"]);
	});
});

describe("renderBrief", () => {
	it("leads with the head, because that is what the verdict binds to", () => {
		const out = renderBrief({
			head: "30e98f4c",
			issue: 412,
			issueTitle: "Reaper leaves worktrees behind",
			criteria: ["resolves at run time"],
			files: ["src/a.ts"],
		});
		expect(out.split("\n")[0]).toBe("head:    30e98f4c");
		expect(out).toContain("closes:  #412 — Reaper leaves worktrees behind");
	});
});
