/**
 * `guard-content-probe` pure core — the guard-touching decision-record content predicate,
 * extracted so the review gate, the driver (via trivial-diff), and ship-it Step 0 all
 * classify a guard-touching `.decisions/**` change through ONE shared function rather than
 * three independently maintained copies of the grep.
 *
 * The classification RESULT was already correct at ship-it Step 0, yet the review gate and
 * the driver classified §CP by PATH alone — so a guard-relaxing decision record read NON-§CP
 * at review + driver and was caught only at ship-it. If ship-it is ever
 * bypassed, that guard-touching change routes as ordinary work — the latent §CP-routing hole
 * this core closes by being the single content probe every stage calls.
 *
 * This is a GENERIC content-shape check over guard/fail-closed/enforcement vocabulary, NEVER
 * a hardcoded record/name list — an author-declared tag is self-defeating (the agent that
 * lacks the discipline to hold the guard also won't tag it), and a named deny-list cannot
 * cover future wording. "You cannot relax a guard without naming it," so a
 * probe over the guard vocabulary catches the class an author tag would let slip.
 *
 * Single source: the canonical `GUARD_ADR_RE` vocabulary is NOT re-declared here — it is
 * parsed from `gh-issue-intake-formats.md` §CP, the one definition ship-it Step 0 and the
 * reviewer fan re-resolve, exactly as `class-probe` parses `HAS_*_RE`. There is no second
 * copy to drift.
 *
 * Fail-closed by construction: an unreadable §CP boundary defaults to match-everything, an
 * uncompilable regex matches everything, and a null/empty decision-record body
 * (a delete/404/unreadable head) classifies guard-touching — the probe over-matches a
 * merely-guard-*citing* record to a cheap human approval rather than risk missing a
 * guard-*relaxer* that would auto-ship a weakened gate.
 */

/**
 * Fail-closed default: `.` matches every decision-record word ⇒ every touched `.decisions/**` file is
 * guard-touching ⇒ §CP. Byte-identical intent to ship-it Step 0's `GUARD_ADR_RE='.'` fallback:
 * an unreadable/incomplete §CP over-classifies to §CP, never silently exempts.
 */
export const FAILCLOSED_GUARD_ADR_RE = ".";

/**
 * Parse the canonical `GUARD_ADR_RE='…'` line out of `gh-issue-intake-formats.md` §CP.
 * Matches only the single-quoted canonical assignment (`GUARD_ADR_RE='…'`), never a
 * double-quoted re-assignment. A missing line falls back to the fail-closed default — the
 * source is single, so this only bites on a truncated read.
 */
export const parseGuardAdrRe = (formatsText: string): string =>
	formatsText.match(/^GUARD_ADR_RE='([^']*)'/m)?.[1] ?? FAILCLOSED_GUARD_ADR_RE;

/** Why the probe decided as it did — surfaced for the human reason line. */
export type GuardProbeReason =
	| "unreadable-body"
	| "guard-vocabulary-match"
	| "uncompilable-regex"
	| "no-match";

export interface GuardProbeResult {
	/** True ⇒ the decision-record content is guard-touching ⇒ §CP (merge-authority hold). */
	readonly guardTouching: boolean;
	readonly reason: GuardProbeReason;
}

/**
 * Is a decision record's content guard-touching (§CP by content)? Pure and total.
 *
 * Fail-closed order, transcribing ship-it Step 0 exactly:
 *   1. body null/empty ⇒ guard-touching (a record that couldn't be read at head is never
 *      proven guard-free — the `[ -z "$body" ] → BLOCKING` clause).
 *   2. `guardRe` won't compile ⇒ guard-touching (a broken boundary must never silently
 *      match nothing).
 *   3. body matches `guardRe` (case-insensitive, like `grep -Ei`) ⇒ guard-touching.
 *   4. otherwise ⇒ not guard-touching.
 */
export const probeGuardContent = (
	body: string | null | undefined,
	guardRe: string,
): GuardProbeResult => {
	if (body === null || body === undefined || body.trim() === "") {
		return {guardTouching: true, reason: "unreadable-body"};
	}
	let re: RegExp;
	try {
		re = new RegExp(guardRe, "i");
	} catch {
		return {guardTouching: true, reason: "uncompilable-regex"};
	}
	return re.test(body)
		? {guardTouching: true, reason: "guard-vocabulary-match"}
		: {guardTouching: false, reason: "no-match"};
};
