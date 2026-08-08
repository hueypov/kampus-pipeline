/** Pure decisions for Git's caller-agnostic `reference-transaction` boundary. */
export const ZERO_OID = "0000000000000000000000000000000000000000";
export const HEAD_REF = "HEAD";
export const SYMREF_VALUE_PREFIX = "ref:";

export interface RefUpdate {
	readonly oldOid: string;
	readonly newOid: string;
	readonly refName: string;
}

export interface ComparisonFacts {
	readonly comparisonOid: string | null;
	readonly comparisonIsAncestorOfNew: boolean;
}

export interface CheckoutContext {
	readonly isPrimaryCheckout: boolean;
}

export type RefDecision =
	| {readonly kind: "allow"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

export const decideRefUpdate = (update: RefUpdate, guardedRef: string, facts: ComparisonFacts): RefDecision => {
	if (update.refName !== guardedRef) return {kind: "allow", reason: `${update.refName} is outside guarded ref ${guardedRef}`};
	if (update.newOid === ZERO_OID) return {kind: "refuse", reason: `refusing to delete guarded primary ref ${guardedRef}`};
	// A same-value write moves nothing, so it cannot diverge anything. Git fires these routinely —
	// `git stash push` and `git reset --hard HEAD` re-write the current branch at its current oid —
	// and refusing one strands a merely-BEHIND primary: with origin ahead, the divergence test below
	// reads the standstill as a rewrite and aborts the stash/reset that precedes the very pull that
	// would catch the branch up (first hit self-hosting, pulling main after #68 merged). The match
	// is only as wide as what git itself proved: the old value is validated against the ref before
	// the prepared hook fires, and a caller that asserts no old value arrives zero-filled — such a
	// write stays on the strict ancestry path below, fail-closed.
	if (update.newOid === update.oldOid) return {kind: "allow", reason: `${guardedRef} is unchanged (same-value write)`};
	if (facts.comparisonOid === null) return {kind: "allow", reason: `comparison ref is unavailable; allowing ${guardedRef} update`};
	if (update.newOid === facts.comparisonOid) return {kind: "allow", reason: `${guardedRef} matches its comparison ref`};
	if (facts.comparisonIsAncestorOfNew) return {kind: "allow", reason: `${guardedRef} is a fast-forward of its comparison ref`};
	return {
		kind: "refuse",
		reason: `refusing a diverging ${guardedRef} update: ${update.newOid.slice(0, 12)} is not a provable fast-forward of ${facts.comparisonOid.slice(0, 12)}`,
	};
};

/** Detect a bare primary-checkout detach across Git versions without refusing an attached commit or branch switch. */
export const decideHeadDetach = (updates: ReadonlyArray<RefUpdate>, context: CheckoutContext): RefDecision => {
	if (!context.isPrimaryCheckout) return {kind: "allow", reason: "linked worktree HEAD is not the shared primary checkout"};
	const branchTargets = new Set(updates.filter((update) => update.refName.startsWith("refs/heads/") && update.newOid !== ZERO_OID).map((update) => update.newOid));
	for (const update of updates) {
		if (update.refName !== HEAD_REF || update.newOid === ZERO_OID) continue;
		if (update.newOid.startsWith(SYMREF_VALUE_PREFIX) || branchTargets.has(update.newOid)) continue;
		return {kind: "refuse", reason: `refusing a bare HEAD detach on the shared primary checkout (${update.newOid.slice(0, 12)})`};
	}
	return {kind: "allow", reason: "no bare primary-checkout HEAD detach"};
};

export const decideTransaction = (decisions: ReadonlyArray<RefDecision>): RefDecision =>
	decisions.find((decision) => decision.kind === "refuse") ?? {kind: "allow", reason: "no guarded transaction hazard"};
