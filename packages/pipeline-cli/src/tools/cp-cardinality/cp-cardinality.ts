/**
 * `cp-cardinality` pure core — the deterministic §CP discharge decision ship-it runs at
 * its control-plane approval gate, keyed on `@kamp-us/control-plane` team cardinality
 * (the deterministic control-plane approval policy, enforcing decision the originating work item / the originating work item).
 *
 * The gate used to resolve the degenerate team shapes (one present member, or zero) by
 * agent judgment, and the same conditions produced opposite verdicts across runs — the
 * the originating work item non-determinism. This core makes the whole discharge policy a pure function of
 * data the ship-it bash resolves over `gh api` REST (team members, PR author, and the two
 * current-head approval signals), so the verdict is reproducible: same inputs → same
 * decision. ship-it does the REST IO and marker matching (the integration half); this core
 * owns the branch (the tested half), the same split class-probe uses for ship-it Step 0.
 *
 * The branch transcribes the deterministic control-plane approval policy's `case "$N"` reference exactly:
 *   N == 0                 → STOP, fail closed (no accountable human).
 *   N == 1, sole == author → a current-head self-approval marker by the sole owner discharges.
 *   N == 1, sole != author → the single member's current-head approval discharges.
 *   N >= 2                 → the non-author control-plane approval requirement holds: a current-head APPROVED review by a DIFFERENT
 *                            control-plane member discharges; a self-approval never does.
 */

/** The gate outcome ship-it acts on: enqueue-eligible, or STOP at `awaiting control-plane approval`. */
export type CpDecision = "discharge" | "stop";

/** Which the deterministic control-plane approval policy cardinality branch produced the decision — surfaced for the human reason line. */
export type CpBranch = "empty" | "single-owner-self" | "single-owner-other" | "multi-member";

/**
 * The resolved gate state, all as data so the decision is pure. `members` is the active,
 * human `@kamp-us/control-plane` roster; the two `*AtHead` flags are the SHA-bound signals
 * ship-it resolves against the PR's current head (the SHA-bound, one-verdict-per-gate contract), never a stale-head signal.
 */
export interface CpCardinalityInput {
	/** Active human control-plane team logins (the core dedupes and drops blanks). */
	readonly members: ReadonlyArray<string>;
	/** The PR author login. */
	readonly author: string;
	/** A current-head APPROVED review by a control-plane member who is NOT the author exists. */
	readonly nonAuthorApprovalAtHead: boolean;
	/** A current-head self-approval marker authored by the sole owner exists (N==1 discharge signal). */
	readonly selfApprovalAtHead: boolean;
}

export interface CpVerdict {
	readonly decision: CpDecision;
	/** Count of distinct present control-plane members — the `N` of the deterministic control-plane approval policy's `case "$N"`. */
	readonly n: number;
	readonly branch: CpBranch;
	/** Human-readable justification, cites the governing ADR branch. */
	readonly reason: string;
}

/** Distinct, non-blank logins — trims and dedupes so a whitespace/duplicate roster line can't skew `N`. */
const distinctMembers = (members: ReadonlyArray<string>): ReadonlyArray<string> => {
	const seen = new Set<string>();
	for (const raw of members) {
		const login = raw.trim();
		if (login.length > 0) seen.add(login);
	}
	return [...seen];
};

/**
 * Decide whether the §CP gate discharges, per the deterministic control-plane approval policy's cardinality branch. Pure and total:
 * every shape resolves to `discharge` or `stop` with a reason — there is no path that defers
 * to judgment, which is the whole point (kill the documented failure non-determinism). Fail-closed by
 * construction: only positive evidence of the branch's required current-head signal discharges;
 * an empty roster, an unresolvable author, or a missing signal all STOP.
 */
export const decideCpCardinality = (input: CpCardinalityInput): CpVerdict => {
	const members = distinctMembers(input.members);
	const n = members.length;
	const author = input.author.trim();

	// An unresolvable author cannot be matched against the roster — fail closed rather than
	// guess the single-owner-self branch (which would let a missing author self-discharge).
	if (author.length === 0) {
		return {
			decision: "stop",
			n,
			branch: n === 1 ? "single-owner-self" : n >= 2 ? "multi-member" : "empty",
			reason:
				"§CP: PR author could not be resolved — cannot key the cardinality branch, fail closed (the deterministic control-plane approval policy).",
		};
	}

	if (n === 0) {
		return {
			decision: "stop",
			n,
			branch: "empty",
			reason:
				"§CP N==0: the @kamp-us/control-plane team is empty — no accountable human to discharge the boundary, fail closed (the deterministic control-plane approval policy).",
		};
	}

	if (n === 1) {
		const soleIsAuthor = members[0] === author;
		if (soleIsAuthor) {
			// The sole owner IS the team; GitHub blocks their native self-approval, so a deliberate
			// current-head self-approval marker is the only discharge signal (the deterministic control-plane approval policy N==1). A
			// self-approval never discharges when N>=2 — this branch is the sole place it counts.
			return input.selfApprovalAtHead
				? {
						decision: "discharge",
						n,
						branch: "single-owner-self",
						reason:
							"§CP N==1 (sole owner == author): a current-head self-approval marker by the sole owner discharges §CP (the deterministic control-plane approval policy).",
					}
				: {
						decision: "stop",
						n,
						branch: "single-owner-self",
						reason:
							"§CP N==1 (sole owner == author): no current-head self-approval marker by the sole owner — STOP (the deterministic control-plane approval policy).",
					};
		}
		return input.nonAuthorApprovalAtHead
			? {
					decision: "discharge",
					n,
					branch: "single-owner-other",
					reason:
						"§CP N==1 (sole member != author): the sole control-plane member's current-head approval discharges §CP (the deterministic control-plane approval policy).",
				}
			: {
					decision: "stop",
					n,
					branch: "single-owner-other",
					reason:
						"§CP N==1 (sole member != author): no current-head approval by the sole control-plane member — STOP (the deterministic control-plane approval policy).",
				};
	}

	// N >= 2: the non-author control-plane approval requirement's two-person control, unchanged. A self-approval is explicitly not a
	// discharge here (the deterministic control-plane approval policy Banned) — only a different member's current-head approval counts.
	return input.nonAuthorApprovalAtHead
		? {
				decision: "discharge",
				n,
				branch: "multi-member",
				reason: `§CP N>=2 (N=${n}): a current-head APPROVED review by a different control-plane member discharges §CP (the non-author control-plane approval requirement/0175).`,
			}
		: {
				decision: "stop",
				n,
				branch: "multi-member",
				reason: `§CP N>=2 (N=${n}): no current-head APPROVED review by a control-plane member other than the author — STOP (the non-author control-plane approval requirement/0175).`,
			};
};
