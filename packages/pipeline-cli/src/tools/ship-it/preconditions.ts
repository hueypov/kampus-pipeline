import * as Exit from "../../exit-codes.ts";
import {
	type ClassificationPolicy,
	classifyPaths,
	requiredNamespaces,
} from "../class-probe/class-probe.ts";
import {GATES, type VerdictGate} from "../verdict/verdict-match.ts";

/**
 * The pure core for `ship-it`: the precondition decisions and the order they are evaluated in.
 *
 * IO-free. The verbs supply facts; this decides what those facts mean and which code says so.
 */

/**
 * `ship-it`'s slice of the shared exit table (`src/exit-codes.ts`).
 *
 * It allocates from the one table every verb uses rather than numbering its own, so a caller
 * driving `report`, `triage`, `write-code`, `review-code` and `ship-it` in a sweep reads one
 * meaning per code (#22).
 */
export const EXIT = {
	OK: Exit.OK,
	FAILED: Exit.FAILED,
	NO_VERDICT: Exit.GATE_MISSING,
	VERDICT_FAIL: Exit.GATE_FAIL,
	VERDICT_STALE: Exit.GATE_STALE,
	CHECKS_RED: Exit.CHECKS_FAILED,
	CHECKS_PENDING: Exit.NOT_YET,
	APPROVAL_MISSING: Exit.REFUSED_POLICY,
	MERGE_UNKNOWN: Exit.WRITE_UNKNOWN,
	NOT_MERGEABLE: Exit.ZERO_SCOPE,
	PRECONDITION_UNKNOWN: Exit.PRECONDITION_UNKNOWN,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** One precondition's outcome: satisfied, or refused with the code naming who owns it next. */
export type Precondition =
	| {readonly name: string; readonly ok: true; readonly detail: string}
	| {readonly name: string; readonly ok: false; readonly code: ExitCode; readonly detail: string};

export const ok = (name: string, detail: string): Precondition => ({name, ok: true, detail});
export const refused = (name: string, code: ExitCode, detail: string): Precondition => ({
	name,
	ok: false,
	code,
	detail,
});

/** The state of one required gate, as `verdict read` resolves it. */
export type GateState =
	| {readonly _tag: "pass"; readonly sha: string}
	| {readonly _tag: "fail"}
	| {readonly _tag: "stale"; readonly sha: string}
	| {readonly _tag: "none"}
	| {readonly _tag: "unknown"; readonly reason: string};

/** A gate's outcome as a precondition. Anything but a current-head PASS refuses. */
export const gatePrecondition = (gate: string, state: GateState): Precondition => {
	switch (state._tag) {
		case "pass":
			return ok(`gate ${gate}`, `PASS @ ${state.sha.slice(0, 7)} (current head)`);
		case "fail":
			return refused(`gate ${gate}`, EXIT.VERDICT_FAIL, "FAIL at the current head");
		case "stale":
			return refused(
				`gate ${gate}`,
				EXIT.VERDICT_STALE,
				`bound to ${state.sha.slice(0, 7)}, not the current head`,
			);
		case "none":
			return refused(`gate ${gate}`, EXIT.NO_VERDICT, "no verdict — this PR was never gated");
		case "unknown":
			return refused(`gate ${gate}`, EXIT.PRECONDITION_UNKNOWN, `could not read: ${state.reason}`);
	}
};

/** CI as a precondition. `none` is UNKNOWN, never green — see below. */
export const checksPrecondition = (checks: {
	readonly state: "green" | "red" | "pending" | "none";
	readonly failing: ReadonlyArray<string>;
	readonly pending: ReadonlyArray<string>;
}): Precondition => {
	switch (checks.state) {
		case "green":
			return ok("checks", "all required checks green");
		case "red":
			return refused("checks", EXIT.CHECKS_RED, `failing: ${checks.failing.join(", ")}`);
		case "pending":
			return refused("checks", EXIT.CHECKS_PENDING, `pending: ${checks.pending.join(", ")} — not yet`);
		case "none":
			// No check having reported is not the same fact as checks having reported and passed.
			// Treating it as green is how a merge gate passes vacuously on a repository with no CI,
			// which is the failure the reference implementation's doctor warns about explicitly.
			return refused(
				"checks",
				EXIT.PRECONDITION_UNKNOWN,
				"no checks reported for this head — cannot confirm CI, which is not the same as green",
			);
	}
};

/** Whether the provider says the PR can merge at all. */
export const mergeablePrecondition = (pr: {
	readonly state: string;
	readonly draft: boolean;
	readonly merged: boolean;
	readonly mergeableState: string | null;
}): Precondition => {
	if (pr.merged) return refused("mergeable", EXIT.NOT_MERGEABLE, "already merged");
	if (pr.state !== "open") return refused("mergeable", EXIT.NOT_MERGEABLE, `state is ${pr.state}`);
	if (pr.draft) return refused("mergeable", EXIT.NOT_MERGEABLE, "still a draft");
	if (pr.mergeableState === "dirty")
		return refused("mergeable", EXIT.NOT_MERGEABLE, "conflicts with the base");
	return ok("mergeable", pr.mergeableState ?? "clean");
};

/**
 * The first refusal in a precondition list, or null when every one passed.
 *
 * Evaluation reports one owner at a time on purpose: each code names a different stage, and a wall
 * of refusals asks the caller to decide which to act on — the judgment this verb exists to remove.
 */
export const firstRefusal = (
	preconditions: ReadonlyArray<Precondition>,
): Extract<Precondition, {ok: false}> | null =>
	preconditions.find((p): p is Extract<Precondition, {ok: false}> => !p.ok) ?? null;

/**
 * The gates a changed-file list requires, derived from the classifier.
 *
 * Extracted from the IO path so the decision that used to be wrong is testable without a network
 * call. `null` means the scope could not be established — an empty file list, which the classifier
 * cannot attribute — and the caller refuses on it rather than reading it as "no gates required".
 * That reading is what let an unreviewed pull request pass the merge gate (#60).
 */
export const gatesForFiles = (
	files: ReadonlyArray<string>,
	policy: ClassificationPolicy,
): ReadonlyArray<VerdictGate> | null => {
	if (files.length === 0) return null;
	const gates = requiredNamespaces(classifyPaths(files, policy).classes).map(
		(namespace) => namespace.replace(/^review-/, "") as VerdictGate,
	);
	return gates.length === 0 ? null : gates;
};

/**
 * The gates a `--gates` value names, or null when any token is not a gate.
 *
 * Lives here rather than in the command so the parse that let an unreviewed PR through is testable.
 * It used to FILTER unknown tokens and keep what survived, so `--gates=nonsense` produced an empty
 * required set and the merge check passed with no review. Not a contrived input: the classification
 * policy spells these `docs`/`skills` while the gate namespaces are `doc`/`skill`, so the
 * repository's own vocabulary collapsed the gate to nothing.
 */
export const parseGateList = (raw: string): ReadonlyArray<VerdictGate> | null => {
	const tokens = raw
		.split(",")
		.map((g) => g.trim().replace(/^review-/, ""))
		.filter((g) => g !== "");
	if (tokens.length === 0) return null;
	const gates = tokens.filter((g): g is VerdictGate => (GATES as ReadonlyArray<string>).includes(g));
	return gates.length === tokens.length ? gates : null;
};

/** The verdict-post namespace decision, pure so the refusal that guards the gate record is tested. */
export type NamespaceCheck =
	| {readonly _tag: "allowed"}
	| {readonly _tag: "refused"; readonly required: ReadonlyArray<VerdictGate>}
	| {readonly _tag: "unchecked"};

/**
 * May a verdict in `gate` be posted for a diff of `files`?
 *
 * `policy` is nullable, and null means UNCHECKED — never "classify fail-closed". The fail-closed
 * default is correct for `ship-it`, where classifying everything requires MORE gates and the gate
 * gets stricter; fed to a refusal guard it inverts, because a scope of every-namespace contains
 * every `--gate` value and nothing is ever refused. The first live probe of this guard proved it:
 * run from a worktree with no policy file, it fail-OPENED and posted a design verdict on a code
 * diff — the exact stray this guard exists to stop.
 *
 * `unchecked` — a missing policy or an empty file list — warns rather than refuses: this is not
 * the last line of defence (`ship-it` re-derives the same scope at the merge and refuses there),
 * and blocking every review on an unreadable scope would stop all work to prevent something
 * already caught downstream. A merge on unknown scope is unsafe; a review withheld on unknown
 * scope is just lost.
 */
export const namespaceCheck = (
	gate: VerdictGate,
	files: ReadonlyArray<string>,
	policy: ClassificationPolicy | null,
): NamespaceCheck => {
	if (policy === null) return {_tag: "unchecked"};
	const required = gatesForFiles(files, policy);
	if (required === null) return {_tag: "unchecked"};
	return required.includes(gate) ? {_tag: "allowed"} : {_tag: "refused", required};
};
