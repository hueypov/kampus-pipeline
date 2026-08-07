/**
 * The pure core for the `triage` verbs: provenance detection and preserve-block composition.
 *
 * IO-free. These two are the deterministic halves of the two steps that carry invariants nothing
 * else enforces — `provenance` decides what a machine may close, and `enrich` decides whether an
 * original survived a rewrite — so both are decided here where they can be tested, not inside a
 * network call where they cannot.
 */

/** Who filed an issue, as far as its body can prove. */
export type Provenance = "agent" | "human" | "ambiguous";

/** The literal marker `report file` emits. Its presence IS the agent signal. */
const AGENT_MARKER = "Filed by an agent";

/** A trailing `<sub>…</sub>` line — the footer's shape, whether or not it carries the marker. */
const FOOTER_LINE = /<sub>(.*?)<\/sub>/s;

/**
 * Resolve filing provenance from a body.
 *
 * **Authorship is deliberately not consulted.** Agents run under one token, so every filing shows
 * the same author and authorship answers a different question than the one asked.
 *
 * A footer-shaped line that does not carry the marker resolves to `ambiguous`, never to `human`:
 * something wrote a footer and we cannot read it, which is not the same as nobody having written
 * one. The caller then treats ambiguous as human, so the failure falls toward protection.
 */
export const provenanceOf = (body: string): Provenance => {
	const footer = FOOTER_LINE.exec(body);
	if (!footer) return "human";
	const inner = footer[1] ?? "";
	if (inner.includes(AGENT_MARKER)) return "agent";
	// A `<sub>` used for something else entirely (a caption, a note) is not a failed footer.
	// Only a line carrying footer-shaped fields counts as one we could not read.
	return /session|branch|model|·/.test(inner) ? "ambiguous" : "human";
};

const REPORT_SUMMARY = "Original report (verbatim)";
const BRIEF_SUMMARY = "Original brief (verbatim)";
const EPIC_HEADER = "**Epic — awaiting plan.**";

/** Does this body already carry a preserve block? A second enrich would nest one inside another. */
export const hasPreserveBlock = (body: string): boolean =>
	body.includes(`<summary>${REPORT_SUMMARY}</summary>`) ||
	body.includes(`<summary>${BRIEF_SUMMARY}</summary>`);

/**
 * The original text a preserve block holds, or null when there is none.
 *
 * This is what makes the round-trip check possible: `enrich` composes a body, writes it, reads it
 * back, and extracts the original from what landed. Comparing that against what it preserved is
 * the only evidence that the rewrite did not eat it.
 */
export const preservedOriginal = (body: string): string | null => {
	const m = /<summary>Original (?:report|brief) \(verbatim\)<\/summary>\n([\s\S]*?)\n<\/details>/.exec(
		body,
	);
	return m ? (m[1] ?? "").trim() : null;
};

/**
 * Compose an enriched body: the rewrite on top, the original preserved verbatim beneath.
 *
 * An epic is wrapped in place instead — `rewrite` must be empty and nothing goes above the brief
 * but a one-line header. The brief is what a planner reads, so a rewrite above it forks the
 * planner's input rather than clarifying it.
 */
export const composeEnriched = (opts: {
	readonly original: string;
	readonly rewrite: string;
	readonly epic: boolean;
}): string => {
	const summary = opts.epic ? BRIEF_SUMMARY : REPORT_SUMMARY;
	const lead = opts.epic ? EPIC_HEADER : opts.rewrite.replace(/\s+$/, "");
	const preserved = opts.original.replace(/\s+$/, "");
	return `${lead}\n\n<details>\n<summary>${summary}</summary>\n\n${preserved}\n\n</details>\n`;
};

export interface TriageRefusal {
	readonly code: number;
	readonly message: string;
}

/**
 * The pre-write guards for `enrich`, in the order a caller can act on them.
 *
 * The nesting check comes before anything about content: re-enriching a body that already carries
 * a preserve block produces two originals, and a reader then has no way to tell which is
 * authoritative — a worse outcome than either refusing or overwriting.
 */
export const checkEnrichInput = (opts: {
	readonly current: string;
	readonly rewrite: string;
	readonly epic: boolean;
}): TriageRefusal | null => {
	if (hasPreserveBlock(opts.current)) {
		return {code: 2, message: "already carries a preserve block — re-enriching would nest it"};
	}
	if (opts.epic && opts.rewrite.trim() !== "") {
		return {
			code: 2,
			message: "--epic given but stdin is not empty — an epic's brief is never rewritten over",
		};
	}
	if (!opts.epic && opts.rewrite.trim() === "") {
		return {code: 2, message: "empty rewrite on stdin — refusing to replace a body with nothing"};
	}
	return null;
};
