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

/**
 * The `mergeable_state` values that permit a merge. Every other value refuses.
 *
 * This is an allowlist because the denylist it replaced returned `ok` for everything it did not
 * name, and `blocked` — the state GitHub reports when branch protection will refuse the merge — was
 * one of those. The merge gate's own precondition therefore answered "ok blocked" and exited 0 on a
 * pull request that could not merge, fail-open in the one verb with merge authority (#99). Adding a
 * state here is now a deliberate edit; an unrecognised one is not permission.
 *
 * `unstable` is permitted because it means only NON-required checks are red. The required ones are
 * `checksPrecondition` above, which refuses on its own — permitting `unstable` here does not weaken
 * that, and refusing it would make this precondition answer a question it does not own.
 */
const MERGEABLE: ReadonlySet<string> = new Set(["clean", "unstable"]);

/**
 * Why a refused state refuses, where the value alone does not say it. The detail always names the
 * state, so a caller reading the row learns which one to act on.
 *
 * `behind` refuses by policy: it is mergeable but stale, and the allowlist's premise is that an
 * unhandled state is not permission. Moving it to `MERGEABLE` is the one-line change that reverses
 * that call.
 */
const NOT_MERGEABLE_REASON: Readonly<Record<string, string>> = {
	blocked: "branch protection has not been satisfied",
	dirty: "conflicts with the base",
	behind: "the base has moved ahead of it",
	draft: "the provider still reports it as a draft",
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
	const state = pr.mergeableState;
	// GitHub reports `unknown` — and omits the field entirely — while it is still computing
	// mergeability. That is an absent answer, not a negative one, so it lands on the same code as
	// every other could-not-read precondition here rather than on NOT_MERGEABLE.
	if (state === null || state === "unknown") {
		return refused(
			"mergeable",
			EXIT.PRECONDITION_UNKNOWN,
			`${state ?? "absent"} — the provider has not resolved mergeability, which is not the same as mergeable`,
		);
	}
	if (MERGEABLE.has(state)) return ok("mergeable", state);
	const why = NOT_MERGEABLE_REASON[state];
	return refused(
		"mergeable",
		EXIT.NOT_MERGEABLE,
		why === undefined ? `${state} — not a state this gate permits` : `${state} — ${why}`,
	);
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

/** Both sides of a pull request's policy, once each has been established as trustworthy. */
export type SidedPolicies = {
	readonly base: ClassificationPolicy;
	readonly head: ClassificationPolicy;
};

/**
 * The gates a pull request requires, resolved against BOTH sides of its policy.
 *
 * One side is never enough. Classified against the base alone, a PR that changes the classification
 * policy is gated by the rule it exists to retire — #93 merged requiring two namespaces where its
 * own head policy requires three. Against the head alone, a PR that DELETES a rule would delete the
 * gate that should have reviewed the deletion.
 *
 * `gates` is therefore the **union**: a namespace either side requires is required. That is the
 * fail-closed reading and the only one needing no ruling on which side is authoritative. The
 * alternative — refusing outright whenever the sides disagree — would make every policy-changing PR
 * wait on a human to assert what the gate could have derived, which is the workaround this defect
 * already forced once (#120). See ADR 0002.
 *
 * `only` names the namespaces exactly one side asked for, and `ship-it check` prints them. That is
 * **information, not routing**: it carries no exit code, no precondition, and no label, and nothing
 * tells an agent shipper to read it — a human watching the run learns the sides disagreed, the agent
 * that merges does not. What refuse-on-disagreement would have bought is genuinely given up;
 * recording the disagreement is what makes that loss legible, not what compensates for it.
 *
 * `null` gates means the scope could not be established at all — an empty file list — and carries
 * the same meaning it does in `gatesForFiles`: refuse, never "no gates required".
 */
export type PrGateScope = {
	readonly gates: ReadonlyArray<VerdictGate> | null;
	readonly base: ReadonlyArray<VerdictGate> | null;
	readonly head: ReadonlyArray<VerdictGate> | null;
	/** The gates exactly one side requires — the base/head disagreement, reported rather than hidden. */
	readonly only: ReadonlyArray<VerdictGate>;
};

export const prGateScope = (
	files: ReadonlyArray<string>,
	policies: SidedPolicies,
): PrGateScope => {
	const base = gatesForFiles(files, policies.base);
	const head = gatesForFiles(files, policies.head);
	const inBase = new Set(base ?? []);
	const inHead = new Set(head ?? []);
	const union = GATES.filter((gate) => inBase.has(gate) || inHead.has(gate));
	return {
		gates: union.length === 0 ? null : union,
		base,
		head,
		only: union.filter((gate) => inBase.has(gate) !== inHead.has(gate)),
	};
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
 * The required set comes from `prGateScope`, the same function `ship-it` derives its merge scope
 * from, so the reviewer's answer and the shipper's cannot silently differ (#120).
 *
 * `policies` is nullable, and null means UNCHECKED — never "classify fail-closed". The fail-closed
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
	policies: SidedPolicies | null,
): NamespaceCheck => {
	if (policies === null) return {_tag: "unchecked"};
	// The file read takes one 100-item page. At that count a complete list is indistinguishable
	// from a truncated one, and here the failure direction inverts ship-it's: a dropped path can
	// drop the gate that would have ALLOWED this verdict, refusing a legitimate review. Unknown
	// scope on a refusal guard means unchecked, never a guess.
	if (files.length >= 100) return {_tag: "unchecked"};
	const required = prGateScope(files, policies).gates;
	if (required === null) return {_tag: "unchecked"};
	return required.includes(gate) ? {_tag: "allowed"} : {_tag: "refused", required};
};

/**
 * The policy `namespaceCheck` may act on, from whatever the loader produced.
 *
 * The loader NEVER returns null — on an unreadable policy it fail-closes internally to the
 * classify-everything policy with `trusted: false`. The first wiring wrote `loaded?.policy ?? null`
 * and believed it had plumbed the unchecked path; the `?? null` was dead code, the untrusted
 * fail-closed policy flowed straight into the guard, and the guard fail-opened in every worktree —
 * the same inversion the core had just been fixed for, one seam deeper, found by review probing the
 * live binary from a policy-less root. The trust flag is the signal, and discarding it was the bug.
 */
export const guardPolicy = (
	loaded: {readonly policy: ClassificationPolicy; readonly trusted: boolean} | null,
): ClassificationPolicy | null => (loaded !== null && loaded.trusted ? loaded.policy : null);

/**
 * Both sides of a PR's loaded policy, or null when EITHER side is untrusted.
 *
 * One trusted side is not half a check here. The untrusted side loads as the classify-everything
 * fallback, which unions to every namespace and leaves the refusal guard with nothing it can refuse
 * — the same fail-open `guardPolicy` exists to close, arriving through the union instead of through
 * a single load.
 */
export const guardPolicies = (
	loaded: {
		readonly base: {readonly policy: ClassificationPolicy; readonly trusted: boolean};
		readonly head: {readonly policy: ClassificationPolicy; readonly trusted: boolean};
	} | null,
): SidedPolicies | null => {
	const base = guardPolicy(loaded?.base ?? null);
	const head = guardPolicy(loaded?.head ?? null);
	return base === null || head === null ? null : {base, head};
};
