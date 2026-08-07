/**
 * Unit tests for the `plan-epic` pure core: child shape, the create-once key, and the brief proof.
 * IO-free — no tracker boundary here.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	briefDivergence,
	briefOf,
	checkChildInput,
	childKey,
	composeChild,
	criteriaCount,
	hasSpec,
	isFirstPlan,
	matchExisting,
} from "./child.ts";

const CODES = {empty: 3, malformed: 4, zeroScope: 7};
const SPEC = "### What to build\nPersist a bookmark.\n\n### Acceptance criteria\n- [ ] it saves\n";

describe("criteriaCount", () => {
	it("counts checkbox items in either marker", () => {
		expect(criteriaCount("- [ ] a\n* [x] b\n")).toBe(2);
	});

	it("ignores a checkbox inside a fenced block", () => {
		// A spec quoting the child template would otherwise satisfy the guard with an example.
		expect(criteriaCount("```md\n- [ ] not a criterion\n```\n")).toBe(0);
	});

	it("does not count an empty checkbox line", () => {
		expect(criteriaCount("- [ ] \n")).toBe(0);
	});

	it("counts a criterion after a fenced block closes", () => {
		expect(criteriaCount("```\ncode\n```\n- [ ] real\n")).toBe(1);
	});
});

describe("hasSpec", () => {
	it("accepts the heading at any of the levels a child body uses", () => {
		expect(hasSpec("## What to build\nx")).toBe(true);
		expect(hasSpec("### what to build\nx")).toBe(true);
	});

	it("does not match the phrase in prose", () => {
		expect(hasSpec("this explains what to build and why")).toBe(false);
	});

	it("does not match a heading inside a fence", () => {
		expect(hasSpec("```\n### What to build\n```")).toBe(false);
	});
});

describe("checkChildInput", () => {
	it("accepts a well-formed child", () => {
		expect(checkChildInput({body: SPEC, stories: [2]}, CODES)).toBeNull();
	});

	it("refuses an empty body before anything else", () => {
		// An unread pipe is byte-identical to an empty one, so this must be its own refusal rather
		// than falling through to a shape complaint about a body that never arrived.
		expect(checkChildInput({body: "  \n", stories: [2]}, CODES)?.code).toBe(CODES.empty);
	});

	it("refuses a body with no spec section", () => {
		expect(checkChildInput({body: "- [ ] it saves", stories: [2]}, CODES)?.message).toContain(
			"What to build",
		);
	});

	it("refuses a body with no acceptance criterion", () => {
		const r = checkChildInput({body: "### What to build\nsomething", stories: [2]}, CODES);
		expect(r?.code).toBe(CODES.malformed);
		expect(r?.message).toContain("decides for itself what done meant");
	});

	it("refuses a child with no story trace, distinctly from a shape problem", () => {
		// Different owners: a shape problem is the body, an untraced child is the plan.
		const r = checkChildInput({body: SPEC, stories: []}, CODES);
		expect(r?.code).toBe(CODES.zeroScope);
		expect(r?.code).not.toBe(CODES.malformed);
	});
});

describe("composeChild", () => {
	it("puts the trace above the spec", () => {
		const out = composeChild({epic: 412, stories: [2, 4], body: SPEC});
		expect(out.split("\n")[0]).toBe("**Stories:** #2, #4");
		expect(out).toContain("**Epic:** #412");
		expect(out).toContain("### What to build");
	});

	it("keeps the caller's body verbatim below the trace", () => {
		const tricky = "### What to build\n\n```bash\ngh api repos/x\n```\n\n- [ ] works";
		expect(composeChild({epic: 1, stories: [1], body: tricky})).toContain(tricky);
	});
});

describe("childKey / matchExisting", () => {
	it("treats case and inner whitespace as the same child", () => {
		// A re-emitted step can differ in both without being a different child; a byte-equality key
		// would file the twin the guard exists to prevent.
		expect(childKey("  One User  Saves ")).toBe(childKey("one user saves"));
	});

	it("treats a differing word as a different child", () => {
		expect(childKey("saves a bookmark")).not.toBe(childKey("saves two bookmarks"));
	});

	it("finds an existing child regardless of case", () => {
		const existing = [{number: 9, title: "One user saves one bookmark"}];
		expect(matchExisting(existing, "ONE USER SAVES ONE BOOKMARK")?.number).toBe(9);
	});

	it("returns null when nothing matches", () => {
		expect(matchExisting([{number: 9, title: "a"}], "b")).toBeNull();
	});
});

describe("briefOf", () => {
	const brief = "**Epic — awaiting plan.**\n\n<details>\n<summary>Original brief (verbatim)</summary>\n\nthe brief\n\n</details>";

	it("is everything above the first section this stage writes", () => {
		expect(briefOf(`${brief}\n\n## Plan (plan-epic)\n\nstuff\n\n## Dependencies\n\n### Phase 1`)).toBe(
			brief,
		);
	});

	it("stops at Dependencies when there is no plan section yet", () => {
		expect(briefOf(`${brief}\n\n## Dependencies\n\n### Phase 1`)).toBe(brief);
	});

	it("is the whole body when neither section exists", () => {
		expect(briefOf(brief)).toBe(brief);
	});

	it("does not stop at a heading that merely mentions the section", () => {
		const body = "## Dependencies of the retry helper\n\ntext";
		expect(briefOf(body)).toBe(body);
	});
});

describe("isFirstPlan", () => {
	it("is true for a body carrying neither section", () => {
		expect(isFirstPlan("**Epic — awaiting plan.**\n\nthe brief")).toBe(true);
	});

	it("is false once a dependencies section exists", () => {
		// The case the first live run got wrong: reading append-vs-replace from the FLAGS refused a
		// legitimate first plan, because a plan block is the splice's re-plan signal.
		expect(isFirstPlan("brief\n\n## Dependencies\n\n### Phase 1")).toBe(false);
	});

	it("is false once a plan section exists, even with no dependencies yet", () => {
		expect(isFirstPlan("brief\n\n## Plan (plan-epic)\n\ntext")).toBe(false);
	});

	it("is not fooled by a heading that merely starts with the word", () => {
		expect(isFirstPlan("## Dependencies of the retry helper\n\ntext")).toBe(true);
	});
});

describe("briefDivergence", () => {
	it("is null when the brief survived", () => {
		expect(briefDivergence("the brief", "the brief")).toBeNull();
	});

	it("reports where the divergence starts and what is on each side", () => {
		// The index alone is not actionable — a planner told only "it changed" has to diff two issue
		// bodies by hand to find out what it destroyed.
		const d = briefDivergence("the brief stands", "the brief moved");
		expect(d?.index).toBe(10);
		expect(d?.expected).toBe("stands");
		expect(d?.actual).toBe("moved");
	});

	it("reports a truncation as a divergence at the truncation point", () => {
		expect(briefDivergence("abcdef", "abc")?.index).toBe(3);
	});
});
