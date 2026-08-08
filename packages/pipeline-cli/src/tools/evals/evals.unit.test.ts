/**
 * Unit tests for the `evals` pure core. IO-free.
 *
 * The rule these are written to is the one the tool enforces: a check that cannot fail is worth
 * nothing. So each lint rule is pinned in BOTH directions — the shape it must catch, and a
 * near-miss it must leave alone. A linter that flags everything is as useless as one that flags
 * nothing, and costs an author more.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	AMBIENT_RESTATEMENT,
	ambientOverlap,
	deriveTier,
	lintEvalSet,
	namesObservable,
	renderFindings,
} from "./evals.ts";

const set = (cases: ReadonlyArray<Record<string, unknown>>, skill = "report") => ({
	skill_name: skill,
	evals: cases,
});

const good = {
	name: "a-case",
	grounding: "contract.md T1",
	prompt: "You are mid-task and notice the retry helper swallows the abort reason.",
	assertions: ["Files the observation rather than mentioning it in the reply"],
};

const rules = (findings: ReadonlyArray<{rule: string}>) => findings.map((f) => f.rule);

describe("namesObservable / deriveTier", () => {
	it.each([
		"exits 3 when stdin is empty",
		"the exit status is non-zero",
		"invokes `pipeline cli tracker create-issue`",
		"prints nothing on stdout",
	])("treats %j as mechanically checkable", (a) => {
		expect(namesObservable(a)).toBe(true);
	});

	it.each([
		"Classifies the issue correctly",
		"Does not inflate the severity to manufacture urgency",
		"Can articulate why it chose that seam",
	])("treats %j as judgment", (a) => {
		expect(namesObservable(a)).toBe(false);
	});

	it("is deterministic only when EVERY assertion is mechanical", () => {
		expect(deriveTier(["exits 3", "prints `none` on stdout"])).toBe("deterministic");
		expect(deriveTier(["exits 3", "chose the right seam"])).toBe("graded");
	});

	it("defaults an empty assertion list to graded, never deterministic", () => {
		// The asymmetry: mis-deriving judgment as mechanical reports an ungraded green; the reverse
		// only costs a model run.
		expect(deriveTier([])).toBe("graded");
	});
});

describe("ambientOverlap — the grades-the-repository check", () => {
	const ambient = "File autonomously. Do not propose-first or ask the user for permission.";

	it("scores a near-restatement above the threshold", () => {
		// The real defect shape: an assertion that a run reading only the ambient context satisfies,
		// which proves the model read the repo rather than that the skill works.
		expect(ambientOverlap("Does NOT ask the user for permission", ambient)).toBeGreaterThanOrEqual(
			AMBIENT_RESTATEMENT,
		);
	});

	it("leaves an assertion that merely shares vocabulary alone", () => {
		expect(
			ambientOverlap("Composes the body as the six sections named in the skill", ambient),
		).toBeLessThan(AMBIENT_RESTATEMENT);
	});

	it("compares against a single sentence, not the whole document", () => {
		// Against a long enough document almost any assertion overlaps somewhere, which would make
		// the check fire on everything and be turned off.
		const sprawling = ["Unrelated line one.", "Another about permission.", "A third about users."].join(
			"\n",
		);
		expect(ambientOverlap("Does NOT ask the user for permission", sprawling)).toBeLessThan(
			AMBIENT_RESTATEMENT,
		);
	});

	it("is zero for an assertion made only of stop words and code", () => {
		expect(ambientOverlap("it is `x`", ambient)).toBe(0);
	});
});

describe("lintEvalSet", () => {
	it("passes a well-formed case", () => {
		expect(lintEvalSet(set([good]), {skill: "report", ambient: ""})).toEqual([]);
	});

	it("refuses an empty set rather than calling it clean", () => {
		// An empty set passes every run and measures nothing — the vacuous pass this tool exists for.
		expect(rules(lintEvalSet(set([]), {skill: "report", ambient: ""}))).toEqual(["empty-set"]);
	});

	it("refuses a prompt that invokes the skill by name", () => {
		const r = lintEvalSet(set([{...good, prompt: "/report the retry helper bug"}]), {
			skill: "report",
			ambient: "",
		});
		expect(rules(r)).toContain("skill-invoked-in-prompt");
	});

	it("does not flag a prompt that merely mentions the word", () => {
		const r = lintEvalSet(set([{...good, prompt: "Write a report on the retry helper."}]), {
			skill: "report",
			ambient: "",
		});
		expect(rules(r)).not.toContain("skill-invoked-in-prompt");
	});

	it("refuses a case with no assertions", () => {
		const r = lintEvalSet(set([{...good, assertions: []}]), {skill: "report", ambient: ""});
		expect(rules(r)).toContain("no-assertions");
	});

	it("refuses two cases sharing an identifier", () => {
		expect(rules(lintEvalSet(set([good, good]), {skill: "report", ambient: ""}))).toContain(
			"duplicate-id",
		);
	});

	it("flags an assertion that restates the ambient context as a DEFECT", () => {
		const r = lintEvalSet(set([{...good, assertions: ["Does NOT ask the user for permission"]}]), {
			skill: "report",
			ambient: "File autonomously. Do not propose-first or ask the user for permission.",
		});
		expect(r.find((f) => f.rule === "ambient-restatement")?.severity).toBe("defect");
	});

	it("treats a missing grounding as a risk, not a defect", () => {
		const {grounding: _drop, ...ungrounded} = good;
		const r = lintEvalSet(set([ungrounded]), {skill: "report", ambient: ""});
		expect(r.find((f) => f.rule === "no-grounding")?.severity).toBe("risk");
	});

	it("flags a compound assertion as a risk rather than blocking on it", () => {
		// The judgment of whether two clauses are really two claims is not mechanical, so this
		// advises rather than refuses — a linter that blocks on a guess gets disabled.
		const r = lintEvalSet(
			set([{...good, assertions: ["Files the issue and returns to the interrupted task"]}]),
			{skill: "report", ambient: ""},
		);
		expect(r.find((f) => f.rule === "compound-assertion")?.severity).toBe("risk");
	});

	it("does not read an `and` inside a code span as a second claim", () => {
		const r = lintEvalSet(set([{...good, assertions: ["invokes `find . -a and -b`"]}]), {
			skill: "report",
			ambient: "",
		});
		expect(rules(r)).not.toContain("compound-assertion");
	});
});

describe("renderFindings", () => {
	it("puts defects above risks", () => {
		const out = renderFindings([
			{severity: "risk", caseId: "b", rule: "compound-assertion", detail: "x"},
			{severity: "defect", caseId: "a", rule: "no-assertions", detail: "y"},
		]);
		expect(out.split("\n")[0]).toContain("no-assertions");
	});
});
