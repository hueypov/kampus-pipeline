/**
 * Test fixtures — small builders for the map domain shapes and a canonical
 * well-formed map body, so each test states only what it varies. Plain TypeScript data,
 * with no Effect runtime.
 */
import type {SubIssue, WayfinderMap, WayfinderMapLedger} from "./Map.ts";

/** A canonical, well-formed `wayfinder:map` body — the formats §worked-example shape. */
export const cleanMapBody = `## Destination
kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new person in.

## Decisions-so-far
- Invites are karma-gated, not seat-gated. — from #101
- The invite artifact is a single-use signed link. — from #102

## Open frontier
- #103 — Investigation: does better-auth's session model let us mint a single-use invite token?
- #104 — Decision (decision-owner-fork): should an invited çaylak start at 0 karma?

## Graduated fog
- #101 — Decided invites are karma-gated. → spawned #104
- #102 — Decided the artifact is a signed link. → spawned #103
`;

/**
 * A well-formed map body carrying exactly the content the parser does **not**
 * model: a lead-in comment and paragraph above the first section, an indented note
 * under `## Decisions-so-far`, a trailing note under `## Open frontier`, a
 * destination that wraps across lines, and a fifth section outside the four. §Field
 * notes sanctions all of it ("carries an extra note under a section, still means
 * what it means"), so it is the fixture a mutation must return byte-for-byte —
 * `cleanMapBody` cannot prove that, since it holds nothing the parser would drop.
 */
export const annotatedMapBody = `<!-- charted by wayfinder -->
This map tracks the kefil invite flow. Do not renumber its tickets.

## Destination
kamp.us has a working invite (kefil) flow: an existing yazar can vouch a new
person in, and that person lands as a çaylak with a clear first-run path.

## Decisions-so-far
- Invites are karma-gated, not seat-gated. — from #101

  Note: nothing is deleted here; a revision lands as a new superseding line.

## Open frontier
- #103 — Investigation: does better-auth's session model let us mint a single-use
  invite token without a new table?
- #104 — Decision (founder-decision-fork): should an invited çaylak start at 0 karma?

Frontier tickets are listed oldest sub-issue first.

## Graduated fog
- #101 — Decided invites are karma-gated. → spawned #103

## Notes
Freeform prose the four-section parser never models.
`;

/**
 * A well-formed parsed map: two decisions (each attributed), an answerable
 * frontier ticket (the originating work item) and a decision-owner-fork (the originating work item), and two graduated
 * fog entries. Overrides let a test vary one section.
 */
export const map = (overrides: Partial<WayfinderMap> = {}): WayfinderMap => ({
	destination: {present: true, text: "A working invite flow."},
	decisionsSoFar: {
		present: true,
		entries: [
			{text: "Invites are karma-gated. — from #101", fromIssue: 101},
			{text: "The artifact is a signed link. — from #102", fromIssue: 102},
		],
	},
	openFrontier: {
		present: true,
		entries: [
			{issue: 103, question: "#103 — Investigation: token storage?", founderDecisionFork: false},
			{
				issue: 104,
				question: "#104 — Decision (decision-owner-fork): starting karma?",
				founderDecisionFork: true,
			},
		],
	},
	graduatedFog: {
		present: true,
		entries: [
			{issue: 101, note: "#101 — Decided karma-gated. → spawned #104", spawned: [104]},
			{issue: 102, note: "#102 — Decided signed link. → spawned #103", spawned: [103]},
		],
	},
	...overrides,
});

/**
 * Resolved sub-issues that are all open — the boundary's output for a map whose
 * frontier is genuinely outstanding. A test needing a closed or state-unresolved
 * ticket overrides that one entry rather than rebuilding the set.
 */
export const openSubIssues = (numbers: ReadonlyArray<number>): ReadonlyArray<SubIssue> =>
	numbers.map((number) => ({number, state: "open"}));

/** A decoded ledger over a well-formed map whose frontier refs are real, open sub-issues. */
export const ledger = (overrides: Partial<WayfinderMapLedger> = {}): WayfinderMapLedger => ({
	number: 100,
	map: map(),
	subIssues: openSubIssues([101, 102, 103, 104]),
	...overrides,
});
