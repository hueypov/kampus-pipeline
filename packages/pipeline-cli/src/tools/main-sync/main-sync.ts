export type MainSyncState = {
	readonly primaryBranch: string | null;
	readonly currentBranch: string | null;
	readonly trackedChanges: boolean;
	/**
	 * Present only when the additive primary-index policy was valid and enabled.
	 * This shares the commit guard's classifier without making an unavailable
	 * policy a new reason to block an otherwise safe synchronization.
	 */
	readonly protectedStagedDeletionCount?: number;
	readonly protectedStagedDeletionThreshold?: number;
};

export type MainSyncDecision =
	| {readonly kind: "refuse"; readonly reason: string}
	| {readonly kind: "sync"; readonly checkoutPrimary: boolean};

/** Pure safety decision: mutation is permitted only from a provably clean checkout. */
export const decideMainSync = (state: MainSyncState): MainSyncDecision => {
	if (state.primaryBranch === null) return {kind: "refuse", reason: "the primary branch could not be resolved"};
	if (
		state.protectedStagedDeletionCount !== undefined &&
		state.protectedStagedDeletionThreshold !== undefined &&
		state.protectedStagedDeletionCount >= state.protectedStagedDeletionThreshold
	) {
		return {
			kind: "refuse",
			reason: `${state.protectedStagedDeletionCount} protected staged deletion(s) meet the primary-index guard threshold ${state.protectedStagedDeletionThreshold}`,
		};
	}
	if (state.trackedChanges) return {kind: "refuse", reason: "the checkout has tracked modifications"};
	return {kind: "sync", checkoutPrimary: state.currentBranch !== state.primaryBranch};
};
