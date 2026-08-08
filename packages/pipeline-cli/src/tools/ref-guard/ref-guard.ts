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
	/** What the guarded ref resolves to right now, independent of the old value the caller asserted. */
	readonly currentOid: string | null;
	/** The guarded ref's value in `packed-refs`, which outlives a deletion of its loose copy. */
	readonly packedOid: string | null;
}

export interface CheckoutContext {
	/**
	 * The value Git has staged for the shared primary checkout's OWN `HEAD` in THIS transaction, or
	 * `null` when the shared HEAD is not the ref being written.
	 *
	 * The question is whose HEAD is under transaction — NOT which checkout invoked Git. Asking the
	 * second is what refused `git worktree add --detach` from the primary: that command writes the
	 * NEW worktree's HEAD, yet runs in the primary's context. Asking merely whether the shared HEAD
	 * is locked is not enough either, because Git locks it for every write that dereferences through
	 * it — `commit`, `reset --hard`, `stash push` — so an unrelated concurrent one would refuse the
	 * same worktree add all over again. Carrying the staged VALUE is what scopes the fact to this
	 * transaction; see `sharedHeadPending` in `command.ts` for how each ref backend answers it.
	 */
	readonly sharedHeadPending: string | null;
	/**
	 * Whether the shared checkout is mid-`rebase`/`bisect`. Git detaches the shared HEAD itself to
	 * replay commits and reattaches it in the same command, so those detaches strand nobody — but on
	 * stdin the first one is indistinguishable from `git checkout <sha>`. Refusing it aborted an
	 * everyday `git rebase` AND left `.git/rebase-merge` behind for the operator to clean up.
	 */
	readonly operationInProgress: boolean;
}

export type RefDecision =
	| {readonly kind: "allow"; readonly reason: string}
	| {readonly kind: "refuse"; readonly reason: string};

export const decideRefUpdate = (update: RefUpdate, guardedRef: string, facts: ComparisonFacts): RefDecision => {
	if (update.refName !== guardedRef) return {kind: "allow", reason: `${update.refName} is outside guarded ref ${guardedRef}`};
	if (update.newOid === ZERO_OID) {
		// `git pack-refs` reports the second half of its work — dropping the LOOSE copy of a ref it has
		// just written into `packed-refs` — as a deletion: `<current> 0000…0 refs/heads/<primary>`. The
		// ref survives at that very value in the packed store, so this is a standstill wearing a
		// delete's clothes, and refusing it aborted every `gc`/`pack-refs` run in the repository.
		//
		// What keeps a REAL delete refused is that Git reports one with a ZERO-filled old value —
		// `0000…0 0000…0 <ref>` — so it can never match a packed oid, which is always a real oid or
		// absent. The prune is the only deletion-shaped transaction that arrives carrying the old
		// value, which is exactly what makes the old value the discriminator. Measured on git 2.50.1
		// for `update-ref -d` and `branch -D`, against a packed-only ref and against a ref holding a
		// loose and a packed copy at the same oid: every genuine delete zero-filled, the prune did not.
		// So this branch is unreachable for a genuine delete; it does not rely on a second transaction
		// in the same command being refused first, nor on any ordering between them. That is a
		// narrower thing to keep true — one observable property of a single transaction, rather than
		// a sequence across several — but it is still a measured property of Git, not a structural
		// impossibility. If a future Git reported a genuine delete carrying its real old value, a
		// delete of a PACKED primary would match the packed oid and be allowed. That is fail-OPEN, so
		// the measurement above is load-bearing: re-run it before trusting this rung on a Git whose
		// deletion reporting has changed.
		if (facts.packedOid !== null && facts.packedOid === update.oldOid) return {kind: "allow", reason: `${guardedRef} survives in packed-refs at ${update.oldOid.slice(0, 12)} (loose-copy prune)`};
		return {kind: "refuse", reason: `refusing to delete guarded primary ref ${guardedRef}`};
	}
	// A same-value write moves nothing, so it cannot diverge anything. Git fires these routinely —
	// `git stash push` and `git reset --hard HEAD` re-write the current branch at its current oid —
	// and refusing one strands a merely-BEHIND primary: with origin ahead, the divergence test below
	// reads the standstill as a rewrite and aborts the stash/reset that precedes the very pull that
	// would catch the branch up (first hit self-hosting, pulling main after #68 merged). The match
	// is only as wide as what git itself proved: the old value is validated against the ref before
	// the prepared hook fires, and a caller that asserts no old value arrives zero-filled — such a
	// write stays on the strict ancestry path below, fail-closed.
	if (update.newOid === update.oldOid) return {kind: "allow", reason: `${guardedRef} is unchanged (same-value write)`};
	// The same standstill, measured against the ref store rather than against the caller's assertion.
	// `git pack-refs` (so `git gc`, so the `gc --auto` inside `commit`/`fetch`/`merge`/`pull`) migrates
	// a loose ref into `packed-refs` by writing it at its OWN current value with a ZERO-filled old
	// value — `0000…0 <current> refs/heads/<primary>` — which sails past the test above and, on a
	// merely-BEHIND primary, is read as a rewrite one rung down. Nothing is moving, so nothing can
	// diverge (measured on git 2.50.1).
	if (facts.currentOid !== null && update.newOid === facts.currentOid) return {kind: "allow", reason: `${guardedRef} already points at ${update.newOid.slice(0, 12)} (standstill)`};
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
	// Only the shared checkout's own HEAD is in scope. A linked worktree's HEAD — whether it is
	// being created detached or detached later — is a different ref in a different ref store, and
	// detaching it strands nobody. A same-value write is deliberately NOT excused here, because
	// `git update-ref --no-deref HEAD <oid> <oid>` on an attached primary reports the resolved oid
	// as its old value and still detaches (measured on git 2.50.1).
	if (context.sharedHeadPending === null) return {kind: "allow", reason: "the shared primary checkout's HEAD is not the ref under transaction"};
	if (context.operationInProgress) return {kind: "allow", reason: "the shared checkout is mid-rebase/bisect; Git reattaches its own transient detach"};
	const branchTargets = new Set(updates.filter((update) => update.refName.startsWith("refs/heads/") && update.newOid !== ZERO_OID).map((update) => update.newOid));
	for (const update of updates) {
		if (update.refName !== HEAD_REF || update.newOid === ZERO_OID) continue;
		if (update.newOid.startsWith(SYMREF_VALUE_PREFIX) || branchTargets.has(update.newOid)) continue;
		// The staged value has to be THIS line's, or the evidence belongs to somebody else's
		// in-flight write and says nothing about whether the shared checkout is being detached.
		if (update.newOid !== context.sharedHeadPending) continue;
		return {kind: "refuse", reason: `refusing a bare HEAD detach on the shared primary checkout (${update.newOid.slice(0, 12)})`};
	}
	return {kind: "allow", reason: "no bare primary-checkout HEAD detach"};
};

export const decideTransaction = (decisions: ReadonlyArray<RefDecision>): RefDecision =>
	decisions.find((decision) => decision.kind === "refuse") ?? {kind: "allow", reason: "no guarded transaction hazard"};
