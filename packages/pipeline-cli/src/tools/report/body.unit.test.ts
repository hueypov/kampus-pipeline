/**
 * Unit tests for the `report` pure core: section validation, the classification-prefix refusal,
 * footer composition, and the guard ordering. IO-free — no tracker boundary here.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	assembleBody,
	canDiscriminate,
	checkFileInput,
	checkNoteInput,
	classificationPrefix,
	composeFooter,
	findSectionDefects,
	hasFooter,
} from "./body.ts";
import * as Exit from "../../exit-codes.ts";

const SECTIONS = [
	"## Summary",
	"It broke.",
	"",
	"## What I was doing",
	"Running the sweep.",
	"",
	"## What I observed",
	"Exit 0 with no output.",
	"",
	"## Why it matters",
	"Might hide a real failure.",
	"",
	"## Pointers",
	"`src/sweep.ts`",
	"",
	"## Suggested next step (non-binding)",
	"",
].join("\n");

describe("findSectionDefects", () => {
	it("accepts the six sections with only the closing guess empty", () => {
		expect(findSectionDefects(SECTIONS)).toEqual([]);
	});

	it("reports a missing section by name", () => {
		const body = SECTIONS.replace("## Why it matters\nMight hide a real failure.\n", "");
		expect(findSectionDefects(body)).toContainEqual({kind: "missing", section: "Why it matters"});
	});

	it("reports a present-but-empty required section", () => {
		const body = SECTIONS.replace("Exit 0 with no output.", "   ");
		expect(findSectionDefects(body)).toEqual([{kind: "empty", section: "What I observed"}]);
	});

	it("does not treat a ### subheading as a section delimiter", () => {
		const body = SECTIONS.replace("Exit 0 with no output.", "### Detail\nExit 0 with no output.");
		expect(findSectionDefects(body)).toEqual([]);
	});

	it("does not read a heading out of a fenced code block", () => {
		const body = SECTIONS.replace(
			"`src/sweep.ts`",
			["```markdown", "## Summary", "not a real heading", "```"].join("\n"),
		);
		expect(findSectionDefects(body)).toEqual([]);
	});
});

describe("classificationPrefix", () => {
	it.each([
		["BUG: fix the sweep", "BUG"],
		["security: cookie has no Secure flag", "security"],
		["P0: everything is on fire", "P0"],
	])("refuses %s", (title, expected) => {
		expect(classificationPrefix(title)).toBe(expected);
	});

	it.each([
		"Reaper leaves worktrees behind after a failed sweep",
		"main-sync: fast-forward refuses on a dirty tree",
		"Note: the editor loses focus after save",
	])("allows %s", (title) => {
		expect(classificationPrefix(title)).toBeNull();
	});
});

describe("composeFooter", () => {
	it("always emits the agent marker", () => {
		expect(composeFooter({timestamp: "2026-08-07T16:44:13Z"})).toContain("Filed by an agent");
	});

	it("drops absent fields without leaving a dangling label", () => {
		const footer = composeFooter({session: "a0bd6818", timestamp: "2026-08-07T16:44:13Z"});
		expect(footer).toBe(
			"---\n<sub>Filed by an agent · session `a0bd6818` · 2026-08-07T16:44:13Z</sub>",
		);
		expect(footer).not.toContain("unknown");
		expect(footer).not.toContain("branch");
	});

	it("carries no identity and no path", () => {
		const footer = composeFooter({
			session: "a0bd6818",
			branch: "pipeline/412-reaper",
			timestamp: "2026-08-07T16:44:13Z",
		});
		expect(footer).not.toMatch(/@|\/Users\/|\/home\//);
	});
});

describe("hasFooter / assembleBody", () => {
	it("separates sections from the footer with one blank line", () => {
		const out = assembleBody("## Summary\nIt broke.\n\n\n", "---\n<sub>Filed by an agent · x</sub>");
		expect(out).toBe("## Summary\nIt broke.\n\n---\n<sub>Filed by an agent · x</sub>\n");
	});

	it("detects an already-footered body", () => {
		expect(hasFooter(assembleBody(SECTIONS, composeFooter({timestamp: "t"})))).toBe(true);
		expect(hasFooter(SECTIONS)).toBe(false);
	});
});

describe("checkFileInput guard ordering", () => {
	const ok = {title: "Sweep exits 0 with no output", body: SECTIONS, redact: false};

	it("passes a well-formed filing", () => {
		expect(checkFileInput(ok)).toBeNull();
	});

	it("reports an empty body before anything else, because an unread pipe looks identical", () => {
		expect(checkFileInput({...ok, body: "   "})?.message).toBe(
			"empty body on stdin — nothing to file",
		);
	});

	it("reports a shape defect before a title defect", () => {
		const body = SECTIONS.replace("## Pointers\n`src/sweep.ts`\n", "");
		expect(checkFileInput({...ok, title: "BUG: x", body})?.message).toBe(
			"missing required section 'Pointers'",
		);
	});

	it("refuses a machine-local path in the body", () => {
		const body = SECTIONS.replace("`src/sweep.ts`", "/Users/someone/Library/Caches/x/state.json");
		expect(checkFileInput({...ok, body})?.message).toMatch(/^machine-local path in body/);
	});

	it("refuses a machine-local path in the title too", () => {
		const title = "state written to /Users/someone/Library/Caches/x/state.json";
		expect(checkFileInput({...ok, title})?.message).toMatch(/^machine-local path in body/);
	});

	it("masks instead of refusing under --redact", () => {
		const body = SECTIONS.replace("`src/sweep.ts`", "/Users/someone/Library/Caches/x/state.json");
		expect(checkFileInput({...ok, body, redact: true})).toBeNull();
	});

	it("each refusal carries the shared code naming its kind, not one generic refusal code", () => {
		// Before #22 every one of these was `2`, so a caller could not tell an empty pipe from a
		// leaked path without parsing the message.
		expect(checkFileInput({...ok, body: ""})?.code).toBe(Exit.EMPTY_INPUT);
		expect(checkFileInput({...ok, title: "BUG: x"})?.code).toBe(Exit.MALFORMED_INPUT);
		const leaked = SECTIONS.replace("`src/sweep.ts`", "/Users/someone/Library/Caches/x/s.json");
		expect(checkFileInput({...ok, body: leaked})?.code).toBe(Exit.LEAKED_PATH);
	});
});

describe("checkNoteInput", () => {
	it("does not impose the six-section template on a note", () => {
		expect(checkNoteInput({body: "Hit this again on today's run.", redact: false})).toBeNull();
	});

	it("still refuses an empty note", () => {
		expect(checkNoteInput({body: "\n\n", redact: false})?.message).toBe(
			"empty body on stdin — nothing to add",
		);
	});

	it("still refuses a leaking note", () => {
		expect(
			checkNoteInput({body: "see /Users/someone/tmp/out.log", redact: false})?.message,
		).toMatch(/^machine-local path in body/);
	});
});

describe("canDiscriminate", () => {
	it("rejects a query whose usable tokens are too few to mean anything", () => {
		// "it did the thing" tokenizes to exactly this: neither word is a stopword and both
		// clear the length floor, yet the pair discriminates nothing.
		expect(canDiscriminate(["did", "thing"])).toBe(false);
	});

	it("rejects an empty token set", () => {
		expect(canDiscriminate([])).toBe(false);
	});

	it("accepts a query carrying real terms", () => {
		expect(canDiscriminate(["worktree", "reaper", "stale", "sweep"])).toBe(true);
	});
});
