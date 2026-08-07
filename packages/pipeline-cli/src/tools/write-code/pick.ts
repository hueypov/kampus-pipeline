/**
 * The pure core for the `write-code` verbs: candidate ordering, the closing reference, and the
 * repair-round count.
 *
 * IO-free. The pick is a total function over the queue, which is the point of moving it here — two
 * runs reading the same queue must choose the same issue, and prose asking an agent to "take the
 * oldest in the highest band" cannot promise that.
 */

/** One candidate row, as the stage listing returns it. */
export interface Candidate {
	readonly number: number;
	readonly title: string;
	readonly labels: ReadonlyArray<string>;
	readonly createdAt: string;
}

/** Priority bands, strongest first. An unrecognised band sorts last rather than crashing. */
const BANDS = ["p0", "p1", "p2"] as const;

const bandOf = (labels: ReadonlyArray<string>): number => {
	const i = BANDS.findIndex((b) => labels.includes(b));
	return i === -1 ? BANDS.length : i;
};

const audienceOf = (labels: ReadonlyArray<string>): string | null =>
	labels.find((l) => l.startsWith("ready-for:"))?.slice("ready-for:".length) ?? null;

/**
 * The candidates for a builder, ordered.
 *
 * `readyFor` filters by audience: `agent` is the default because work triage addressed to a person
 * must never surface to a builder. An issue carrying **no** audience label is included for `any`
 * only — an unstated audience is not an implied one, and treating it as `agent` would let every
 * pre-audience issue back into the pool.
 *
 * Ordering is band first, then oldest, then number. The final tiebreak on number exists so the
 * function is total: two issues created in the same second must still order deterministically, or
 * two runs can disagree about which is "next".
 */
export const rankCandidates = (input: {
	readonly rows: ReadonlyArray<Candidate>;
	readonly readyFor: "agent" | "human" | "any";
}): ReadonlyArray<Candidate> => {
	const wanted = input.readyFor;
	return [...input.rows]
		.filter((row) => {
			const who = audienceOf(row.labels);
			if (wanted === "any") return true;
			return who === wanted;
		})
		.sort((a, b) => {
			const band = bandOf(a.labels) - bandOf(b.labels);
			if (band !== 0) return band;
			const age = a.createdAt.localeCompare(b.createdAt);
			if (age !== 0) return age;
			return a.number - b.number;
		});
};

/**
 * The closing reference for an issue.
 *
 * Composed here rather than by a caller because it is the only link three stages read — the gate
 * resolves acceptance criteria through it, the merge closes the issue by it, an epic handoff traces
 * through it — and a PR missing it looks entirely normal until a merge closes nothing.
 */
export const closingReference = (issue: number): string => `Fixes #${issue}`;

/** Does this PR body close `issue`? The check the verb runs against what actually landed. */
export const closesIssue = (body: string, issue: number): boolean =>
	new RegExp(`\\b(?:fixes|closes|resolves)\\s+#${issue}\\b`, "i").test(body);

/** The body a PR is opened with: the author's description, then the closing reference. */
export const composePrBody = (description: string, issue: number): string =>
	`${description.replace(/\s+$/, "")}\n\n${closingReference(issue)}\n`;

/**
 * How many repair rounds a PR has had, read from the round trailer its verdict marker carries.
 *
 * It does NOT count FAIL markers. One verdict per gate is upserted, so the FAIL a repair answered
 * is overwritten by the PASS that follows it — counting them yields 0 after any completed round and
 * can never exceed 1 (#21). The trailer survives the upsert because the comment is patched, not
 * replaced, and `verdict post` maintains it.
 */
export const countFailRounds = (
	comments: ReadonlyArray<{readonly body: string}>,
	gate?: string,
): number => {
	const ns = gate ? `review-${gate}` : "review-(?:code|doc|skill|design)";
	const marker = new RegExp(`^\\s*\\**\\s*${ns}:\\s*\\**\\s*(?:PASS|FAIL)\\b`, "im");
	const trailer = /<!--\s*rounds:\s*(\d+)\s*-->/;
	return comments
		.filter((c) => marker.test(c.body))
		.reduce((most, c) => {
			const m = trailer.exec(c.body);
			const n = m ? Number.parseInt(m[1] ?? "0", 10) : 0;
			return Number.isFinite(n) && n > most ? n : most;
		}, 0);
};

export type CapState = "under" | "at" | "over";

/** Where a round count sits against the cap. `at` and `over` both mean stop. */
export const capState = (rounds: number, cap: number): CapState =>
	rounds < cap ? "under" : rounds === cap ? "at" : "over";
