/**
 * The deterministic structural floor: `validateMap`, `isValidMap`, the
 * graduation-readiness predicate, and the run-stable `mapSignature` — the
 * epic-ledger floor idiom applied to a `wayfinder:map` ledger.
 *
 * `validateMap` is a pure `(WayfinderMapLedger) => readonly Defect[]` over the
 * closed defect enum. Determinism is the contract downstream (the `wayfinder`
 * skill's work/emit modes) read against, and it is enforced two ways: every check
 * derives its findings from section-presence flags and structured entries, never
 * from the input's presentation order; and the final defect list is sorted by
 * canonical defect rank then by the finding's first ref. So the same map always
 * yields a byte-identical defect list and an identical `mapSignature`.
 *
 * Graduation-readiness is orthogonal to validity: `isGraduationReady` asks whether
 * the open frontier holds any *answerable* unknown (a well-formed, non-fork, still
 * open ticket), not whether the map is well-formed. Emission (#S5) gates on both —
 * a valid AND ready map — but the predicate itself is purely about the frontier, so
 * a map can be ready before it is clean and vice versa.
 */
import type {Defect, DefectType} from "./Defect.ts";
import {defectTypeRank} from "./Defect.ts";
import type {FrontierTicket, SubIssue, WayfinderMapLedger} from "./Map.ts";

/**
 * The map's sub-issues that are *positively known* to be closed.
 *
 * Closure has to be proven, never inferred from absence: a sub-issue with no
 * resolved state (an offline decode, a wire value outside the domain union) is not
 * in this set, so both the reconciliation defect and the answerable-frontier filter
 * degrade to their pre-reconciliation behaviour rather than flagging everything.
 * That makes the graceful-absence rule structural — with no state resolved the set
 * is empty and every check below is a no-op — rather than a guard someone must
 * remember to write, which is how `DANGLING_FRONTIER_REF` states the same rule with
 * its explicit `subIssues.length > 0` gate.
 */
const closedSubIssues = (subIssues: ReadonlyArray<SubIssue>): ReadonlySet<number> =>
	new Set(subIssues.filter((s) => s.state === "closed").map((s) => s.number));

/**
 * The open frontier tickets that still block graduation: well-formed (they name a
 * sub-issue), NOT a founder-decision-fork, and NOT already closed. A fork is the
 * preserved human seam `wayfinder` stops on — nothing the automated work loop can
 * clear — so it never blocks readiness; a malformed entry (no issue) is a validity
 * problem, not an answerable unknown, so it is excluded here too and caught by
 * `validateMap`. A closed ticket is finished work, and counting it as outstanding is
 * what strands a map short of graduation forever.
 *
 * Takes the whole ledger, not the parsed body, because closed-ness lives outside
 * the body — the body cannot say whether the ticket it lists is still open.
 */
export const answerableFrontier = (ledger: WayfinderMapLedger): ReadonlyArray<FrontierTicket> => {
	const closed = closedSubIssues(ledger.subIssues);
	return ledger.map.openFrontier.entries.filter(
		(t) => t.issue !== undefined && !t.founderDecisionFork && !closed.has(t.issue),
	);
};

/**
 * Is the map ready to emit — i.e. is the open frontier cleared of every
 * *answerable* unknown? Ready iff `answerableFrontier` is empty: the frontier
 * holds nothing but (optionally) founder-decision-forks, which `wayfinder`
 * surfaces to a human rather than resolving, and tickets already closed. This is
 * the machine-readable substrate the fog-graduation (#S3) and emission (#S5) modes
 * act on instead of prose-guessing whether a map is "done enough" for handoff.
 */
export const isGraduationReady = (ledger: WayfinderMapLedger): boolean =>
	answerableFrontier(ledger).length === 0;

/**
 * Validate a decoded map ledger against the structural floor. Returns the
 * canonical, deterministically-ordered defect set: empty for a well-formed map,
 * otherwise one `Defect` per finding, sorted by defect-type rank then issue ref.
 */
export const validateMap = (ledger: WayfinderMapLedger): ReadonlyArray<Defect> => {
	const defects: Defect[] = [];
	const {number, map, subIssues} = ledger;

	if (!map.destination.present) {
		defects.push({
			type: "MISSING_DESTINATION",
			message: `Map #${number} has no \`## Destination\` section; a map must name the end-state it charts toward.`,
			refs: [number],
		});
	}
	if (!map.decisionsSoFar.present) {
		defects.push({
			type: "MISSING_DECISIONS_SECTION",
			message: `Map #${number} has no \`## Decisions-so-far\` section.`,
			refs: [number],
		});
	}
	if (!map.openFrontier.present) {
		defects.push({
			type: "MISSING_FRONTIER_SECTION",
			message: `Map #${number} has no \`## Open frontier\` section.`,
			refs: [number],
		});
	}
	if (!map.graduatedFog.present) {
		defects.push({
			type: "MISSING_FOG_SECTION",
			message: `Map #${number} has no \`## Graduated fog\` section.`,
			refs: [number],
		});
	}

	// A present-but-empty destination has a heading but no end-state text — the map
	// has no fixed star to steer by. Only checked when the heading exists (its
	// absence is the stronger MISSING_DESTINATION root cause).
	if (map.destination.present && map.destination.text.length === 0) {
		defects.push({
			type: "EMPTY_DESTINATION",
			message: `Map #${number}'s \`## Destination\` section is empty; it must name the end-state concretely enough to tell "arrived" from "not yet".`,
			refs: [number],
		});
	}

	map.decisionsSoFar.entries.forEach((entry, i) => {
		if (entry.fromIssue === undefined) {
			defects.push({
				type: "MALFORMED_DECISION_ENTRY",
				message: `Map #${number} \`## Decisions-so-far\` entry ${i + 1} has no \`— from #N\` origin: "${entry.text}".`,
				refs: [number],
			});
		}
	});

	map.openFrontier.entries.forEach((ticket, i) => {
		if (ticket.issue === undefined) {
			defects.push({
				type: "MALFORMED_FRONTIER_ENTRY",
				message: `Map #${number} \`## Open frontier\` entry ${i + 1} references no sub-issue \`#N\`: "${ticket.question}".`,
				refs: [number],
			});
		}
	});

	map.graduatedFog.entries.forEach((entry, i) => {
		if (entry.issue === undefined) {
			defects.push({
				type: "MALFORMED_FOG_ENTRY",
				message: `Map #${number} \`## Graduated fog\` entry ${i + 1} references no issue \`#N\`: "${entry.note}".`,
				refs: [number],
			});
		}
	});

	// A frontier ticket must reference a REAL sub-issue of the map (formats §Open
	// frontier: frontier tickets are native sub-issues). Resolved against the
	// boundary-supplied `subIssues`; an empty set disables the check (nothing was
	// resolved to compare against — the offline/foreign graceful-absence case),
	// exactly as epic-ledger's `externalRefs`-gated DANGLING_DEP does.
	if (subIssues.length > 0) {
		const known = new Set(subIssues.map((s) => s.number));
		const dangling = map.openFrontier.entries
			.map((t) => t.issue)
			.filter((n): n is number => n !== undefined && !known.has(n))
			.sort((a, b) => a - b);
		for (const n of [...new Set(dangling)]) {
			defects.push({
				type: "DANGLING_FRONTIER_REF",
				message: `Map #${number} \`## Open frontier\` references #${n}, which is not a real sub-issue of the map.`,
				refs: [n],
			});
		}
	}

	// The lockstep rule reconciled against the world: a ticket leaves `## Open
	// frontier` only by its answer landing in `## Decisions-so-far` and the ticket
	// moving to `## Graduated fog`, so a closed ticket still listed as open frontier
	// means those three moved out of step. This is the one drift the body alone
	// cannot show — every other check reads the body against itself.
	const closed = closedSubIssues(subIssues);
	const stale = [
		...new Set(
			map.openFrontier.entries
				.map((t) => t.issue)
				.filter((n): n is number => n !== undefined && closed.has(n)),
		),
	].sort((a, b) => a - b);
	for (const n of stale) {
		defects.push({
			type: "CLOSED_FRONTIER_TICKET",
			message: `Map #${number} \`## Open frontier\` lists #${n}, which is closed; a ticket leaves the frontier only by its answer landing in \`## Decisions-so-far\` and the ticket moving to \`## Graduated fog\`.`,
			refs: [n],
		});
	}

	return defects.sort(
		(a, b) =>
			defectTypeRank(a.type) - defectTypeRank(b.type) || (a.refs[0] ?? 0) - (b.refs[0] ?? 0),
	);
};

/** A map is well-formed iff the floor finds no defect. */
export const isValidMap = (ledger: WayfinderMapLedger): boolean => validateMap(ledger).length === 0;

const signatureToken = (type: DefectType, refs: ReadonlyArray<number>): string =>
	`${type}:${[...refs].sort((a, b) => a - b).join(".")}`;

/**
 * A run-stable fingerprint of a map's defect set — the type+refs of each finding,
 * in canonical order, joined. Two ledgers with the same defects share a signature
 * regardless of entry order; the signature omits messages so a wording change
 * never perturbs it. `"clean"` for a well-formed map.
 */
export const mapSignature = (ledger: WayfinderMapLedger): string => {
	const defects = validateMap(ledger);
	if (defects.length === 0) return "clean";
	return defects.map((d) => signatureToken(d.type, d.refs)).join("|");
};
