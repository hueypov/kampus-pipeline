export type MainSyncState = {
	readonly primaryBranch: string | null;
	readonly currentBranch: string | null;
	readonly trackedChanges: boolean;
};

export type MainSyncDecision =
	| {readonly kind: "refuse"; readonly reason: string}
	| {readonly kind: "sync"; readonly checkoutPrimary: boolean};

/** Pure safety decision: mutation is permitted only from a provably clean checkout. */
export const decideMainSync = (state: MainSyncState): MainSyncDecision => {
	if (state.primaryBranch === null) return {kind: "refuse", reason: "the primary branch could not be resolved"};
	if (state.trackedChanges) return {kind: "refuse", reason: "the checkout has tracked modifications"};
	return {kind: "sync", checkoutPrimary: state.currentBranch !== state.primaryBranch};
};
