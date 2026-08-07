/**
 * Unit tests for the `triage` pure core: provenance detection and preserve-block composition.
 * IO-free — no tracker boundary here.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	checkEnrichInput,
	composeEnriched,
	hasPreserveBlock,
	preservedOriginal,
	provenanceOf,
} from "./body.ts";

const FOOTER = (inner: string) => `---\n<sub>${inner}</sub>`;

describe("provenanceOf", () => {
	it("reads the agent marker", () => {
		expect(provenanceOf(`body\n\n${FOOTER("Filed by an agent · session `abc` · 2026-08-07")}`)).toBe(
			"agent",
		);
	});

	it("treats an absent footer as human-filed", () => {
		expect(provenanceOf("this is broken again")).toBe("human");
	});

	it("treats a footer-shaped line without the marker as ambiguous, never as agent", () => {
		expect(provenanceOf(`body\n\n${FOOTER("session `abc` · 2026-08-07")}`)).toBe("ambiguous");
	});

	it("does not mistake an ordinary <sub> for a failed footer", () => {
		expect(provenanceOf("a caption <sub>fig. 1</sub> in the body")).toBe("human");
	});

	it("never returns agent for a body whose marker is only mentioned, not in a footer", () => {
		// A body discussing the footer must not read as one — this is the case that would let an
		// issue *about* provenance be auto-closed.
		expect(provenanceOf("triage keys auto-close on `Filed by an agent`, which is missing here")).toBe(
			"human",
		);
	});
});

describe("composeEnriched / preservedOriginal round trip", () => {
	const original = "crashed writing state.json\n\nno idea why";

	it("puts the rewrite on top and the original beneath, recoverable byte for byte", () => {
		const out = composeEnriched({original, rewrite: "## Problem\nState lands outside the repo.", epic: false});
		expect(out).toContain("## Problem");
		expect(out).toContain("<summary>Original report (verbatim)</summary>");
		expect(preservedOriginal(out)).toBe(original);
	});

	it("wraps an epic in place with nothing above it but the header", () => {
		const out = composeEnriched({original, rewrite: "", epic: true});
		expect(out.startsWith("**Epic — awaiting plan.**")).toBe(true);
		expect(out).toContain("<summary>Original brief (verbatim)</summary>");
		expect(preservedOriginal(out)).toBe(original);
	});

	it("survives an original that itself contains markdown headings and fences", () => {
		const tricky = "## Summary\n\n```bash\ngh api repos/x/issues\n```\n\n## Pointers\n`src/a.ts`";
		const out = composeEnriched({original: tricky, rewrite: "rewritten", epic: false});
		expect(preservedOriginal(out)).toBe(tricky);
	});

	it("returns null when there is no preserve block", () => {
		expect(preservedOriginal("just a body")).toBeNull();
	});
});

describe("hasPreserveBlock", () => {
	it("detects both summary forms", () => {
		expect(hasPreserveBlock(composeEnriched({original: "x", rewrite: "y", epic: false}))).toBe(true);
		expect(hasPreserveBlock(composeEnriched({original: "x", rewrite: "", epic: true}))).toBe(true);
	});

	it("is false for an un-enriched body", () => {
		expect(hasPreserveBlock("## Summary\nplain")).toBe(false);
	});
});

describe("checkEnrichInput", () => {
	it("accepts a normal enrich", () => {
		expect(checkEnrichInput({current: "plain", rewrite: "## Problem\nx", epic: false})).toBeNull();
	});

	it("refuses re-enriching before it looks at anything else", () => {
		const already = composeEnriched({original: "x", rewrite: "y", epic: false});
		expect(checkEnrichInput({current: already, rewrite: "", epic: false})?.message).toBe(
			"already carries a preserve block — re-enriching would nest it",
		);
	});

	it("refuses a rewrite passed alongside --epic", () => {
		expect(checkEnrichInput({current: "brief", rewrite: "some rewrite", epic: true})?.message).toBe(
			"--epic given but stdin is not empty — an epic's brief is never rewritten over",
		);
	});

	it("refuses an empty non-epic rewrite", () => {
		expect(checkEnrichInput({current: "plain", rewrite: "  \n", epic: false})?.message).toBe(
			"empty rewrite on stdin — refusing to replace a body with nothing",
		);
	});

	it("accepts --epic with empty stdin", () => {
		expect(checkEnrichInput({current: "brief", rewrite: "", epic: true})).toBeNull();
	});
});
