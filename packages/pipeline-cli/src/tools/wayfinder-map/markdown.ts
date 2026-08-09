/**
 * Tolerant markdown parsing for the four `wayfinder:map` sections the validator
 * reads: `## Destination`, `## Decisions-so-far`, `## Open frontier`, and
 * `## Graduated fog`. Per the formats contract these are conventions to read
 * tolerantly, not parser specs — recognize a section by its heading shape
 * (case-insensitive, punctuation-flexible), not by exact whitespace. Parsing is
 * pure and deterministic: the same body always yields the same `WayfinderMap`,
 * with entries emitted in document order.
 *
 * This module also owns *locating* those sections and their list items in the raw
 * line array (`sectionRange`, `listItemRanges`), which is what the write path in
 * `mutate.ts` edits against. Reader and writer share one locator on purpose: the
 * lines the writer removes for a ticket are exactly the lines the reader folded
 * into that ticket's entry, so the two can never disagree about where an entry
 * begins and ends.
 *
 * See `gh-issue-intake-formats.md` §The `wayfinder:map` issue shape for the four
 * sections and the worked example these regexes are calibrated against.
 */
import type {Decision, FogEntry, FrontierTicket, WayfinderMap} from "./Map.ts";

/** Any markdown ATX heading line. */
const ANY_HEADING = /^#{1,6}\s+\S/;

/** An unordered-list item line: `- …`, `* …`, `+ …`. */
const LIST_ITEM = /^\s*[-*+]\s+(\S.*)$/;

const ISSUE_REF = /#(\d+)/g;

/**
 * The four canonical section headings, tolerant of casing and of the punctuation
 * drift the field-notes rule sanctions (`Decisions-so-far` / `Decisions so far`,
 * `Graduated-fog` / `Graduated fog`).
 */
const DESTINATION_HEADING = /^#{1,6}\s+destination\b/i;
const DECISIONS_HEADING = /^#{1,6}\s+decisions?[-\s]+so[-\s]+far\b/i;
const FRONTIER_HEADING = /^#{1,6}\s+open[-\s]+frontier\b/i;
const FOG_HEADING = /^#{1,6}\s+graduated[-\s]+fog\b/i;

/** A `founder-decision-fork` flag anywhere on a frontier line (formats §Open frontier). */
const FOUNDER_FORK = /founder[-\s]decision[-\s]fork/i;

/** A decision line's `— from #N` attribution; captures the origin issue (group 1). */
const FROM_REF = /\bfrom\s+#(\d+)/i;

/** A fog line's `→ spawned #M` follow-on refs; each match captures the spawned issue. */
const SPAWNED_REF = /spawned\s+#(\d+)/gi;

const headingLevel = (line: string): number => {
	const match = /^(#{1,6})\s/.exec(line);
	return match?.[1] ? match[1].length : 0;
};

/**
 * The first `#N` in a line — a frontier ticket's sub-issue, a fog entry's subject.
 * Exported so the write path resolves a ticket to its line by the same rule the
 * parser resolved that line to a ticket.
 */
export const firstIssueRef = (text: string): number | undefined => {
	const match = /#(\d+)/.exec(text);
	return match?.[1] ? Number(match[1]) : undefined;
};

/** The four sections, keyed by the `WayfinderMap` field each one lowers into. */
export type MapSection = "destination" | "decisionsSoFar" | "openFrontier" | "graduatedFog";

const SECTION_HEADING: Record<MapSection, RegExp> = {
	destination: DESTINATION_HEADING,
	decisionsSoFar: DECISIONS_HEADING,
	openFrontier: FRONTIER_HEADING,
	graduatedFog: FOG_HEADING,
};

/**
 * Where a section sits in a body's line array: `heading` is the heading line's
 * own index, and `[start, end)` spans the section's lines with the heading
 * excluded.
 */
export interface SectionRange {
	readonly heading: number;
	readonly start: number;
	readonly end: number;
}

/**
 * Locate the first section whose heading matches `section` in a body's lines: it
 * runs from just after the heading up to the next heading of the same or higher
 * level. `undefined` when the heading is absent — read by the validator as the
 * section's `MISSING_*` defect, and by the writer as "no place to put this line".
 */
export const sectionRange = (
	lines: ReadonlyArray<string>,
	section: MapSection,
): SectionRange | undefined => {
	const headingRe = SECTION_HEADING[section];
	const heading = lines.findIndex((line) => headingRe.test(line));
	if (heading === -1) return undefined;
	const level = headingLevel(lines[heading] ?? "");
	let end = lines.length;
	for (let i = heading + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (ANY_HEADING.test(line) && headingLevel(line) <= level) {
			end = i;
			break;
		}
	}
	return {heading, start: heading + 1, end};
};

interface Section {
	readonly present: boolean;
	/** The section's lines, heading excluded — empty when absent or empty. */
	readonly lines: ReadonlyArray<string>;
}

const sliceSection = (body: string, section: MapSection): Section => {
	const lines = body.split("\n");
	const range = sectionRange(lines, section);
	if (!range) return {present: false, lines: []};
	return {present: true, lines: lines.slice(range.start, range.end)};
};

/**
 * One list item of a section: the folded text the parser reads, plus the span of
 * section-relative lines it occupies. `[start, end)` covers the bullet line and
 * its continuation lines and nothing else, so removing that span removes exactly
 * one entry.
 */
export interface ListItemRange {
	readonly text: string;
	readonly start: number;
	readonly end: number;
}

/**
 * The list items of a section's lines, in document order. A wrapped item's
 * continuation lines fold into its text: a non-blank line under a bullet that is
 * not itself a bullet is glued onto the current item before ref extraction, and a
 * blank line ends the item. Without this a `— from #N` attribution that wraps onto
 * a continuation line (as in the §worked-example map) is dropped, spuriously
 * yielding MALFORMED_DECISION_ENTRY (the originating work item).
 */
export const listItemRanges = (
	sectionLines: ReadonlyArray<string>,
): ReadonlyArray<ListItemRange> => {
	const items: ListItemRange[] = [];
	let current: {parts: string[]; start: number; end: number} | undefined;
	const flush = () => {
		if (current) items.push({text: current.parts.join(" ").trim(), start: current.start, end: current.end});
		current = undefined;
	};
	sectionLines.forEach((line, index) => {
		const match = LIST_ITEM.exec(line);
		if (match?.[1]) {
			flush();
			current = {parts: [match[1].trim()], start: index, end: index + 1};
		} else if (line.trim().length === 0) {
			flush();
		} else if (current) {
			current.parts.push(line.trim());
			current.end = index + 1;
		}
	});
	flush();
	return items;
};

const listItems = (section: Section): ReadonlyArray<string> =>
	listItemRanges(section.lines).map((item) => item.text);

const parseDestination = (body: string): WayfinderMap["destination"] => {
	const section = sliceSection(body, "destination");
	const text = section.lines
		.map((l) => l.trim())
		.filter((l) => l.length > 0)
		.join(" ")
		.trim();
	return {present: section.present, text};
};

const parseDecisions = (body: string): {present: boolean; entries: ReadonlyArray<Decision>} => {
	const section = sliceSection(body, "decisionsSoFar");
	const entries = listItems(section).map((text): Decision => {
		const match = FROM_REF.exec(text);
		return match?.[1] ? {text, fromIssue: Number(match[1])} : {text};
	});
	return {present: section.present, entries};
};

const parseFrontier = (
	body: string,
): {present: boolean; entries: ReadonlyArray<FrontierTicket>} => {
	const section = sliceSection(body, "openFrontier");
	const entries = listItems(section).map(
		(question): FrontierTicket => ({
			issue: firstIssueRef(question),
			question,
			founderDecisionFork: FOUNDER_FORK.test(question),
		}),
	);
	return {present: section.present, entries};
};

const collectSpawned = (text: string): ReadonlyArray<number> => {
	const refs: number[] = [];
	for (const match of text.matchAll(SPAWNED_REF)) {
		if (match[1]) refs.push(Number(match[1]));
	}
	return [...new Set(refs)].sort((a, b) => a - b);
};

const parseFog = (body: string): {present: boolean; entries: ReadonlyArray<FogEntry>} => {
	const section = sliceSection(body, "graduatedFog");
	const entries = listItems(section).map((note): FogEntry => {
		// The graduated issue is the FIRST ref on the line; `spawned #M` refs are
		// follow-on frontier, captured separately, so a line's own subject is never
		// confused with what it spawned.
		const spawned = new Set(collectSpawned(note));
		const allRefs: number[] = [];
		for (const match of note.matchAll(ISSUE_REF)) allRefs.push(Number(match[1]));
		const issue = allRefs.find((n) => !spawned.has(n)) ?? allRefs[0];
		return {issue, note, spawned: [...spawned].sort((a, b) => a - b)};
	});
	return {present: section.present, entries};
};

/**
 * Parse a `wayfinder:map` issue body into a structured `WayfinderMap`. Every
 * section is sliced tolerantly and lowered to structured entries; an absent
 * section is recorded as `present: false` (its `MISSING_*` defect), never thrown
 * on. The result is pure data — `validateMap` and `isGraduationReady` run over it
 * without ever touching markdown again.
 */
export const parseMapBody = (body: string): WayfinderMap => ({
	destination: parseDestination(body),
	decisionsSoFar: parseDecisions(body),
	openFrontier: parseFrontier(body),
	graduatedFog: parseFog(body),
});
