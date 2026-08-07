/**
 * The one exit table every pipeline verb allocates from.
 *
 * A code means the same thing whichever verb produced it, so a caller driving `report`, `triage`,
 * `write-code`, `review-code` and `ship-it` in one sweep can branch on the number without first
 * knowing which verb it came from. Before this existed, `3` meant "backed off", "nothing pickable"
 * and "the check did not discriminate" depending on the caller, and `5` meant three more things
 * (#22).
 *
 * `0`, `1` and `2` are reserved by the CLI interface: the answer, a usage error or a verb that
 * could not run, and a router that resolved no implementation. Everything from `3` up is a fact the
 * verb PROVED.
 *
 * The distinctions that look redundant are the ones that carry the design:
 *
 *  - **{@link ZERO_SCOPE} vs {@link PRECONDITION_UNKNOWN}.** Proven-absent is a fact about the
 *    repository; a read that failed is not a fact about anything. Fusing them is how "could not
 *    check" becomes "nothing to do".
 *  - **{@link INDETERMINATE} vs {@link ZERO_SCOPE}.** A check that ran and matched nothing is an
 *    answer; a check that could not discriminate never ran. Only the first may be acted on.
 *  - **{@link NOT_YET} vs {@link GATE_FAIL}.** Their owners differ. Pending is nobody's defect;
 *    a failure is the author's.
 *  - **{@link WRITE_UNKNOWN} vs {@link FAILED}.** A create or PATCH that timed out may or may not
 *    have landed. Seating that on `1` would make "the provider refused" indistinguishable from
 *    "the binary is broken", and a blind retry is how one split becomes two children.
 *  - **{@link READBACK_MISMATCH} vs {@link WRITE_UNKNOWN}.** The artifact exists and is wrong. That
 *    needs a human, not a retry.
 */

/** The answer is on stdout. */
export const OK = 0;
/** Usage error, an unresolvable repository, or the verb failed to run. */
export const FAILED = 1;
/** No implementation resolved — the router never loaded the verb. */
export const NO_IMPLEMENTATION = 2;

/** Stdin was read and held nothing. Distinct from a read that failed, which is {@link FAILED}. */
export const EMPTY_INPUT = 3;

/**
 * The supplied text or flag value cannot be used as given: a missing required section, a title
 * carrying a classification, a body that would nest a second preserve block, an off-vocabulary
 * classification. The caller's recovery is to fix the input and re-run.
 */
export const MALFORMED_INPUT = 4;

/**
 * The authored text carries a machine-local path and was not redacted.
 *
 * Separate from {@link MALFORMED_INPUT} because the recovery differs: the caller redacts and
 * re-sends rather than restructuring what it wrote.
 */
export const LEAKED_PATH = 5;

/** Another session holds the claim on this target. Back off; do not mutate. */
export const HELD_BY_OTHER = 6;

/**
 * A read that succeeded over nothing, or a target PROVEN absent or closed.
 *
 * *Proven* is the operative word. An unreachable provider is {@link PRECONDITION_UNKNOWN}.
 */
export const ZERO_SCOPE = 7;

/**
 * The check ran but could not discriminate, so nothing was actually compared.
 *
 * Never {@link ZERO_SCOPE}: "I compared and found nothing" and "I could not compare" are different
 * answers, and only the first may be acted on.
 */
export const INDETERMINATE = 8;

/** A precondition is legitimately unfinished — "not yet", never "no". */
export const NOT_YET = 9;

/**
 * Refused by a rule rather than by the input: a human-filed issue may not be closed, an author may
 * not grade their own work, a required approval is absent.
 *
 * The caller cannot fix these by re-sending. Each belongs to a different party.
 */
export const REFUSED_POLICY = 10;

/** A precondition could not be READ. The answer is unknown, which is not the same as unsatisfied. */
export const PRECONDITION_UNKNOWN = 11;

/** The write was attempted and its outcome could not be confirmed. Do not retry blindly. */
export const WRITE_UNKNOWN = 12;

/** The write landed but does not match what was sent. The artifact exists and needs a human. */
export const READBACK_MISMATCH = 13;

/** A required gate's current-head verdict is FAIL. */
export const GATE_FAIL = 14;

/** A verdict exists but is bound to a head that is not current — it describes other code. */
export const GATE_STALE = 15;

/** A required gate has no verdict at all. */
export const GATE_MISSING = 16;

/** A bounded loop reached its cap. Escalate rather than iterating again. */
export const CAP_REACHED = 17;

/**
 * A required CI check reported failure.
 *
 * Separate from {@link GATE_FAIL}: a reviewer's verdict and a build result are different signals
 * even though both route to the author, and a caller that wants to re-run CI must not be told a
 * human said no.
 */
export const CHECKS_FAILED = 18;

export type ExitCode =
	| typeof OK
	| typeof FAILED
	| typeof NO_IMPLEMENTATION
	| typeof EMPTY_INPUT
	| typeof MALFORMED_INPUT
	| typeof LEAKED_PATH
	| typeof HELD_BY_OTHER
	| typeof ZERO_SCOPE
	| typeof INDETERMINATE
	| typeof NOT_YET
	| typeof REFUSED_POLICY
	| typeof PRECONDITION_UNKNOWN
	| typeof WRITE_UNKNOWN
	| typeof READBACK_MISMATCH
	| typeof GATE_FAIL
	| typeof GATE_STALE
	| typeof GATE_MISSING
	| typeof CAP_REACHED
	| typeof CHECKS_FAILED;

/** The whole table in ascending order — the machine-readable form of the contracts' exit tables. */
export const EXIT_TABLE: ReadonlyArray<{readonly code: ExitCode; readonly name: string}> = [
	{code: OK, name: "OK"},
	{code: FAILED, name: "FAILED"},
	{code: NO_IMPLEMENTATION, name: "NO_IMPLEMENTATION"},
	{code: EMPTY_INPUT, name: "EMPTY_INPUT"},
	{code: MALFORMED_INPUT, name: "MALFORMED_INPUT"},
	{code: LEAKED_PATH, name: "LEAKED_PATH"},
	{code: HELD_BY_OTHER, name: "HELD_BY_OTHER"},
	{code: ZERO_SCOPE, name: "ZERO_SCOPE"},
	{code: INDETERMINATE, name: "INDETERMINATE"},
	{code: NOT_YET, name: "NOT_YET"},
	{code: REFUSED_POLICY, name: "REFUSED_POLICY"},
	{code: PRECONDITION_UNKNOWN, name: "PRECONDITION_UNKNOWN"},
	{code: WRITE_UNKNOWN, name: "WRITE_UNKNOWN"},
	{code: READBACK_MISMATCH, name: "READBACK_MISMATCH"},
	{code: GATE_FAIL, name: "GATE_FAIL"},
	{code: GATE_STALE, name: "GATE_STALE"},
	{code: GATE_MISSING, name: "GATE_MISSING"},
	{code: CAP_REACHED, name: "CAP_REACHED"},
	{code: CHECKS_FAILED, name: "CHECKS_FAILED"},
];
