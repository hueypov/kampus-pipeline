/**
 * The write path: the pure core of `wayfinder-map graduate`.
 *
 * **One atomic graduation, never three verbs.** The formats contract's lockstep
 * rule — a ticket leaves `## Open frontier` only by its answer landing in
 * `## Decisions-so-far` and the ticket moving to `## Graduated fog` — is a
 * constraint on the *API shape*, not only on the caller. Three separately-callable
 * verbs would let any caller reach the state the invariant forbids, making the CLI
 * a faster way to corrupt a map than hand-editing it. So `graduateBody` computes
 * all three edits, or refuses and computes none.
 *
 * **Targeted section edits, never a parse → mutate → re-render round trip.** The
 * parser is lossy by design: `listItems` drops non-list prose, `parseDestination`
 * collapses a multi-line destination into one joined line. Re-rendering a
 * `WayfinderMap` back over the body would therefore delete exactly the content the
 * contract sanctions (§Field notes: "a map that … carries an extra note under a
 * section still means what it means"). The companion rule "write canonically"
 * governs the *lines this module emits*, not a licence to re-emit a
 * human-authored body. So every edit here splices whole lines into the raw body
 * and leaves every byte it did not target alone.
 *
 * Pure and total: no IO, no throws. A rejected mutation comes back as a `Refusal`
 * carrying the exit code the command surfaces.
 */
import type {WayfinderMapLedger} from "./Map.ts";
import type {ListItemRange, MapSection, SectionRange} from "./markdown.ts";
import {firstIssueRef, listItemRanges, sectionRange} from "./markdown.ts";
import {validateMap} from "./validate.ts";
import * as Exit from "../../exit-codes.ts";

/** A refused mutation: what went wrong, and the exit code the command exits with. */
export interface Refusal {
	readonly message: string;
	readonly code: number;
}

/**
 * One graduation, as WORK mode's steps 4 and 5 supply it: the frontier ticket
 * being cleared, the answer to record, an optional distinct fog note (the fog
 * records *how the fog cleared*, decisions record *what was decided*), and the
 * frontier lines its answer revealed — each already filed as a real sub-issue and
 * naming it.
 */
export interface Graduation {
	readonly ticket: number;
	readonly decision: string;
	readonly fogNote?: string | undefined;
	readonly spawned: ReadonlyArray<string>;
}

export type GraduateResult =
	| {
			readonly ok: true;
			readonly body: string;
			readonly decisionLine: string;
			readonly fogLine: string;
			readonly frontierLines: ReadonlyArray<string>;
	  }
	| {readonly ok: false; readonly refusal: Refusal};

const refuse = (message: string, code: number): GraduateResult => ({
	ok: false,
	refusal: {message, code},
});

/** The canonical heading each section is named by in a refusal message. */
const SECTION_LABEL: Record<MapSection, string> = {
	destination: "## Destination",
	decisionsSoFar: "## Decisions-so-far",
	openFrontier: "## Open frontier",
	graduatedFog: "## Graduated fog",
};

/** Any `from #N` attribution — the form `graduate` composes and so refuses as input. */
const ANY_FROM_REF = /\bfrom\s+#\d+/i;

/** A leading bullet on caller-supplied text, stripped so the writer owns the marker. */
const LEADING_BULLET = /^[-*+]\s+/;

/**
 * Insert one already-composed list item at the end of a section's list.
 *
 * "End of the list", not "end of the section": an item goes immediately after the
 * last existing item, so a trailing note or prose under the section keeps its
 * place below the list instead of being pushed around by every append.
 */
const appendItem = (sectionLines: ReadonlyArray<string>, line: string): ReadonlyArray<string> => {
	const next = [...sectionLines];
	const items = listItemRanges(next);
	const last = items[items.length - 1];
	if (last) {
		next.splice(last.end, 0, line);
		return next;
	}
	let at = 0;
	for (let i = next.length - 1; i >= 0; i--) {
		if ((next[i] ?? "").trim().length > 0) {
			at = i + 1;
			break;
		}
	}
	next.splice(at, 0, line);
	return next;
};

const removeItem = (
	sectionLines: ReadonlyArray<string>,
	item: ListItemRange,
): ReadonlyArray<string> => {
	const next = [...sectionLines];
	next.splice(item.start, item.end - item.start);
	return next;
};

const overlaps = (a: SectionRange, b: SectionRange): boolean =>
	a.heading < b.end && b.heading < a.end;

/**
 * Compose the graduation's three lines and splice them into `body`, or refuse.
 *
 * The emitted shapes come from the formats contract §The `wayfinder:map` issue
 * shape: a decision carries its `— from #N` origin, a fog entry leads with the
 * graduated issue (the parser reads a fog line's subject as its first non-spawned
 * ref, so the ticket must come first) and trails its `→ spawned #M` refs, and each
 * spawned frontier line carries its own `#M`.
 */
export const graduateBody = (body: string, plan: Graduation): GraduateResult => {
	const decision = plan.decision.trim();
	if (decision.length === 0) {
		return refuse(
			"empty --decision: a graduation must record what was decided or found",
			Exit.MALFORMED_INPUT,
		);
	}
	if (ANY_FROM_REF.test(decision)) {
		return refuse(
			`--decision already carries a "from #N" attribution; graduate composes "— from #${plan.ticket}" itself`,
			Exit.MALFORMED_INPUT,
		);
	}

	const spawnedRefs: number[] = [];
	const frontierLines: string[] = [];
	for (const raw of plan.spawned) {
		const text = raw.trim().replace(LEADING_BULLET, "");
		const ref = firstIssueRef(text);
		if (ref === undefined) {
			return refuse(
				`--spawn "${text}" names no sub-issue #M; a frontier entry without one is MALFORMED_FRONTIER_ENTRY`,
				Exit.MALFORMED_INPUT,
			);
		}
		if (ref === plan.ticket) {
			return refuse(
				`--spawn "${text}" names #${plan.ticket}, the ticket being graduated; a graduation cannot re-open its own frontier entry`,
				Exit.MALFORMED_INPUT,
			);
		}
		spawnedRefs.push(ref);
		frontierLines.push(`- ${text}`);
	}

	const lines = body.split("\n");
	const destinationRange = sectionRange(lines, "destination");
	const decisionsRange = sectionRange(lines, "decisionsSoFar");
	const frontierRange = sectionRange(lines, "openFrontier");
	const fogRange = sectionRange(lines, "graduatedFog");
	const missing = (section: MapSection): GraduateResult =>
		refuse(
			`map has no \`${SECTION_LABEL[section]}\` section; graduate edits the map's sections, it does not invent them`,
			Exit.MALFORMED_INPUT,
		);
	if (!decisionsRange) return missing("decisionsSoFar");
	if (!frontierRange) return missing("openFrontier");
	if (!fogRange) return missing("graduatedFog");

	// Headings drifted to different levels can nest one section inside another
	// (`## Decisions-so-far` followed by `### Open frontier`), and then two splices
	// would land in overlapping spans — silently shredding both. Reading such a map
	// is still fine; writing to it is not, so refuse rather than guess. Destination
	// is included because an edit inside its span would change it, and only CHART
	// mode may.
	const spans: ReadonlyArray<{section: MapSection; range: SectionRange}> = [
		{section: "decisionsSoFar", range: decisionsRange},
		{section: "openFrontier", range: frontierRange},
		{section: "graduatedFog", range: fogRange},
		...(destinationRange ? [{section: "destination" as MapSection, range: destinationRange}] : []),
	];
	for (const a of spans) {
		for (const b of spans) {
			if (a.section !== b.section && overlaps(a.range, b.range)) {
				return refuse(
					`\`${SECTION_LABEL[a.section]}\` and \`${SECTION_LABEL[b.section]}\` nest (drifted heading levels); graduate refuses to splice overlapping sections`,
					Exit.MALFORMED_INPUT,
				);
			}
		}
	}

	const frontierNow = lines.slice(frontierRange.start, frontierRange.end);
	const matches = listItemRanges(frontierNow).filter(
		(item) => firstIssueRef(item.text) === plan.ticket,
	);
	const target = matches[0];
	if (!target) {
		return refuse(
			`#${plan.ticket} is not on \`## Open frontier\`; there is nothing to graduate`,
			Exit.ZERO_SCOPE,
		);
	}
	if (matches.length > 1) {
		return refuse(
			`\`## Open frontier\` names #${plan.ticket} on ${matches.length} entries; removing one would leave the ticket both open and graduated`,
			Exit.MALFORMED_INPUT,
		);
	}

	const decisionLine = `- ${decision} — from #${plan.ticket}`;
	// Each spawned ref gets its own `→ spawned #M`: the contract's fog form, and the
	// only shape the parser's `spawned\s+#(\d+)` sweep reads as more than one ref.
	const spawnedSuffix = spawnedRefs.map((ref) => ` → spawned #${ref}`).join("");
	const fogLine = `- #${plan.ticket} — ${(plan.fogNote ?? decision).trim()}${spawnedSuffix}`;

	const edits = [
		{
			range: decisionsRange,
			next: appendItem(lines.slice(decisionsRange.start, decisionsRange.end), decisionLine),
		},
		{
			range: frontierRange,
			next: frontierLines.reduce<ReadonlyArray<string>>(
				(acc, line) => appendItem(acc, line),
				removeItem(frontierNow, target),
			),
		},
		{range: fogRange, next: appendItem(lines.slice(fogRange.start, fogRange.end), fogLine)},
	].sort((a, b) => b.range.start - a.range.start);

	const out = [...lines];
	for (const edit of edits) {
		out.splice(edit.range.start, edit.range.end - edit.range.start, ...edit.next);
	}

	return {ok: true, body: out.join("\n"), decisionLine, fogLine, frontierLines};
};

const defectToken = (type: string, refs: ReadonlyArray<number>): string =>
	`${type}:${[...refs].sort((a, b) => a - b).join(".")}`;

/**
 * The defects the mutation introduced — the post-mutation defect set minus the
 * pre-mutation one. A map that was already malformed stays the caller's problem;
 * what this catches is a write that *made it worse*, most often a `--spawn` naming
 * an issue that is not yet a real sub-issue of the map (`DANGLING_FRONTIER_REF`).
 */
export const introducedDefects = (
	before: WayfinderMapLedger,
	after: WayfinderMapLedger,
): ReadonlyArray<string> => {
	const had = new Set(validateMap(before).map((d) => defectToken(d.type, d.refs)));
	return validateMap(after)
		.map((d) => defectToken(d.type, d.refs))
		.filter((token) => !had.has(token));
};

const destinationLines = (body: string): ReadonlyArray<string> => {
	const lines = body.split("\n");
	const range = sectionRange(lines, "destination");
	return range ? lines.slice(range.heading, range.end) : [];
};

/**
 * Prove a computed graduation before it is written: the whole lockstep invariant,
 * checked against the mutated body rather than trusted from the code that produced
 * it. Returns `null` when the mutation is safe to PATCH.
 *
 * This runs pre-write on purpose. Every failure here is unrecoverable once the body
 * has landed — a deleted decision entry has no undo — so the map is only ever
 * written after the result has been re-parsed and shown to hold.
 */
export const checkGraduation = (
	before: {readonly body: string; readonly ledger: WayfinderMapLedger},
	after: {readonly body: string; readonly ledger: WayfinderMapLedger},
	ticket: number,
): Refusal | null => {
	const beforeDestination = destinationLines(before.body).join("\n");
	if (destinationLines(after.body).join("\n") !== beforeDestination) {
		return {
			message: "the mutation changed `## Destination`, which only CHART mode may set",
			code: Exit.FAILED,
		};
	}

	const had = before.ledger.map.decisionsSoFar.entries;
	const now = after.ledger.map.decisionsSoFar.entries;
	if (now.length !== had.length + 1) {
		return {
			message: `\`## Decisions-so-far\` went from ${had.length} to ${now.length} entries; a graduation appends exactly one`,
			code: Exit.FAILED,
		};
	}
	for (const [index, entry] of had.entries()) {
		if (now[index]?.text !== entry.text) {
			return {
				message: `\`## Decisions-so-far\` entry ${index + 1} was rewritten; the answer log is append-only`,
				code: Exit.FAILED,
			};
		}
	}

	if (after.ledger.map.openFrontier.entries.some((t) => t.issue === ticket)) {
		return {
			message: `#${ticket} is still on \`## Open frontier\` after the mutation`,
			code: Exit.FAILED,
		};
	}
	if (!after.ledger.map.graduatedFog.entries.some((e) => e.issue === ticket)) {
		return {
			message: `#${ticket} did not land in \`## Graduated fog\``,
			code: Exit.FAILED,
		};
	}

	const introduced = introducedDefects(before.ledger, after.ledger);
	if (introduced.length > 0) {
		return {
			message: `the mutation would introduce ${introduced.length} defect(s) the map did not have: ${introduced.join(", ")}`,
			code: Exit.MALFORMED_INPUT,
		};
	}
	return null;
};

/**
 * The write precondition: the body must still be byte-identical to the one the
 * mutation was computed against.
 *
 * GitHub's issue-body PATCH is last-write-wins with no compare-and-swap, so a
 * concurrent editor's decision entry would vanish with no error anywhere. Re-reading
 * immediately before the write narrows that window to the round trip rather than the
 * whole run; it cannot close it, which is why the write is also read back afterwards.
 * `HELD_BY_OTHER` because the recovery is the claim-race one — back off and re-read,
 * not re-send.
 */
export const bodyPrecondition = (expected: string, current: string): Refusal | null =>
	expected === current
		? null
		: {
				message:
					"the map body changed between read and write — another session is editing it; refusing to overwrite. Re-read and retry",
				code: Exit.HELD_BY_OTHER,
			};
