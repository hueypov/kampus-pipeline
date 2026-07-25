/**
 * `merge-queue-classify` core — the pure, IO-free classifier for ship-it Step 5.5's
 * bounded post-enqueue reconcile (the originating work item).
 *
 * ship-it enqueues a PR to GitHub's merge queue and then watches a bounded batch window
 * to classify the terminal state. It verifies the base and final merged state rather
 * than assuming enqueue equals merge: did the
 * queue land the batch (`merged`), is the PR still in the queue (`queued`), did the
 * queue drop it without merging (`ejected`), or is it still settling into the queue
 * (`pending`)? The old discriminator inferred `ejected` from a momentary
 * `mergeStateStatus != QUEUED` while OPEN — but a freshly-enqueued PR reads
 * `mergeStateStatus = CLEAN` for a few seconds *before* GitHub flips it CLEAN → QUEUED,
 * so a genuinely-queued PR was FALSE-classified `ejected` on the first poll (the documented failure
 * live instance: an ejection comment posted on a healthy queued PR, then retracted by
 * hand).
 *
 * The fix keys the verdict off the **authoritative** merge-queue signal — the REST
 * issue-timeline events GitHub emits: `added_to_merge_queue` on enqueue and
 * `removed_from_merge_queue` on a genuine ejection (GitHub "Managing a merge queue";
 * verified live against these events on the originating pull request). Classification is **last-merge-queue-
 * event-wins**, which also survives a re-enqueue (add → remove → add ⇒ still queued).
 * `mergeStateStatus` is retained only as a *positive* still-queued hint (`QUEUED`),
 * never as the ejection discriminator.
 *
 * The IO lives in `command.ts` (the thin bin, which reads the PR state + timeline via
 * `gh`); this file is the pure predicate over already-resolved ground-truth signals so
 * the classification contract is unit-testable without a live queue (the unit/integration tier boundary; the
 * core-in-its-own-file idiom, the originating work item).
 */

/** The last merge-queue timeline event observed for the PR, or `null` when none yet exists. */
export type LastMergeQueueEvent = "added_to_merge_queue" | "removed_from_merge_queue" | null;

/** The ground-truth signals the reconcile reads per poll — the classifier's whole input. */
export interface MergeQueueSignals {
	/** Did the queue land the merge? True on `merged==true` or PR `state==MERGED`. */
	readonly merged: boolean;
	/** The PR `state` from `gh pr view` — `OPEN` / `MERGED` / `CLOSED`. */
	readonly state: string;
	/**
	 * The **last** merge-queue timeline event (`added_to_merge_queue` /
	 * `removed_from_merge_queue`), or `null` when the queue has emitted none yet — the
	 * enqueue-settle window the old logic mis-read as an ejection.
	 */
	readonly lastMergeQueueEvent: LastMergeQueueEvent;
	/**
	 * `mergeStateStatus` from `gh pr view` — used only as a *positive* still-queued hint
	 * (`QUEUED`), never to infer ejection. Optional: absent ⇒ treated as unknown.
	 */
	readonly mergeStateStatus?: string | undefined;
}

/**
 * The terminal reconcile outcome:
 *   - `merged`  — the queue landed the batch. Terminal success.
 *   - `ejected` — a genuine dequeue: NOT merged AND the last merge-queue event is
 *                 `removed_from_merge_queue`. Route back to repair/re-queue.
 *   - `queued`  — still in the queue: NOT merged AND (last event is
 *                 `added_to_merge_queue` OR `mergeStateStatus == QUEUED`). Keep polling.
 *   - `pending` — the enqueue-settle window: NOT merged, OPEN, and NO merge-queue event
 *                 yet (incl. OPEN + CLEAN before the QUEUED flip). NEVER an ejection.
 */
export type MergeOutcome = "merged" | "ejected" | "queued" | "pending";

/** The classification: the outcome + a human-readable reason naming the deciding signal. */
export interface Classification {
	readonly outcome: MergeOutcome;
	readonly reason: string;
}

const at = (outcome: MergeOutcome, reason: string): Classification => ({outcome, reason});

/**
 * Classify one reconcile poll from the ground-truth signals — the pure fix for the originating work item.
 *
 * Precedence (authoritative-signal-first):
 *   1. `merged` — merged==true or state==MERGED ⇒ terminal success. Checked first: a
 *      landed merge outranks any stale queue event (the final `removed_from_merge_queue`
 *      the queue emits *as* it merges must not read as an ejection — the originating work item carried both
 *      events, but it merged).
 *   2. `ejected` — NOT merged AND last merge-queue event is `removed_from_merge_queue`.
 *      This is the ONLY ejection signal: a genuine dequeue, not a momentary state read.
 *   3. `queued` — NOT merged AND (last event `added_to_merge_queue` OR
 *      mergeStateStatus==QUEUED). A well-formed pending in the queue; keep polling.
 *   4. `pending` — NOT merged AND no merge-queue event yet (the settle window, incl.
 *      OPEN + CLEAN before the QUEUED flip). The the originating work item race. NEVER `ejected`.
 *
 * A momentary OPEN + non-QUEUED state with no `removed_from_merge_queue` event is never
 * an ejection — that is the whole defect this classifier removes.
 */
export const classify = (s: MergeQueueSignals): Classification => {
	if (s.merged || s.state === "MERGED") {
		return at(
			"merged",
			"merged==true or state==MERGED — the queue landed the batch (terminal success)",
		);
	}
	if (s.lastMergeQueueEvent === "removed_from_merge_queue") {
		return at(
			"ejected",
			"not merged and the last merge-queue event is removed_from_merge_queue — a genuine dequeue",
		);
	}
	if (s.lastMergeQueueEvent === "added_to_merge_queue") {
		return at(
			"queued",
			"last merge-queue event is added_to_merge_queue (no subsequent removal) — still queued",
		);
	}
	if (s.mergeStateStatus === "QUEUED") {
		return at("queued", "mergeStateStatus==QUEUED — still in the queue");
	}
	// No merge-queue event yet: the enqueue-settle window (incl. OPEN + CLEAN before the
	// CLEAN → QUEUED flip). Still settling — NEVER an ejection (the documented failure race).
	return at(
		"pending",
		"no merge-queue timeline event yet (enqueue-settle window) — still settling, not ejected",
	);
};

/**
 * Extract the LAST merge-queue event from a REST issue-timeline array — the authoritative
 * `added_to_merge_queue` / `removed_from_merge_queue` events, last-wins (survives a
 * re-enqueue). Robust to the timeline arriving out of order: prefers each event's
 * `created_at`, falling back to array position when a timestamp is absent. Returns `null`
 * when the timeline carries no merge-queue event (the settle window).
 */
export const lastMergeQueueEvent = (
	timeline: ReadonlyArray<{readonly event?: string; readonly created_at?: string}>,
): LastMergeQueueEvent => {
	// Collect only the merge-queue events (with their original index for the timestamp-tie
	// fallback), then pick the last by (created_at, index) — no mutable-over-closure the
	// checker can't narrow.
	const events = timeline
		.map((entry, idx) => ({event: entry.event, key: entry.created_at ?? "", idx}))
		.filter(
			(
				e,
			): e is {
				event: "added_to_merge_queue" | "removed_from_merge_queue";
				key: string;
				idx: number;
			} => e.event === "added_to_merge_queue" || e.event === "removed_from_merge_queue",
		);
	if (events.length === 0) return null;
	const last = events.reduce((a, b) =>
		b.key > a.key || (b.key === a.key && b.idx > a.idx) ? b : a,
	);
	return last.event;
};
