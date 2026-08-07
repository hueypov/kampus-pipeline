/**
 * The pure core for `plan-epic child` and `plan-epic write`.
 *
 * IO-free. Two decisions live here because both have a wrong answer that nothing downstream can
 * detect:
 *
 *  - **Is this child pickable?** A child with no acceptance criterion is picked up anyway, and the
 *    agent that picks it decides for itself what "done" meant. A child with no story trace is work
 *    nobody agreed to. `epic-ledger`'s structural gate fails a plan on exactly these two, and
 *    checking them at the write turns a gate finding into an impossibility — the planner learns
 *    while it still holds the lock, rather than after a fleet has the ledger.
 *  - **Did the brief survive the write?** The brief is triage's output and the planner's input; a
 *    write that ate it destroys the only record of what was approved.
 */

/** The trace line every child carries. Its presence is the "somebody agreed to this" signal. */
const STORIES_PREFIX = "**Stories:**";

/** Fenced blocks are quoted material — a `- [ ]` inside one is an example, not a criterion. */
const stripFences = (body: string): string => {
	const lines = body.split("\n");
	let fenced = false;
	return lines
		.filter((line) => {
			if (/^\s*(?:```|~~~)/.test(line)) {
				fenced = !fenced;
				return false;
			}
			return !fenced;
		})
		.join("\n");
};

/** How many acceptance-criteria checkboxes the body carries, ignoring fenced examples. */
export const criteriaCount = (body: string): number =>
	stripFences(body).split("\n").filter((line) => /^\s*[-*]\s*\[[ xX]\]\s*\S/.test(line)).length;

/** Does the body carry the `### What to build` spec a picker reads first? */
export const hasSpec = (body: string): boolean =>
	/^#{2,4}\s*What to build\s*$/im.test(stripFences(body));

export interface ChildRefusal {
	readonly code: number;
	readonly message: string;
}

/** The exit codes this core names, resolved against the shared table by the command layer. */
export interface ChildCodes {
	readonly empty: number;
	readonly malformed: number;
	readonly zeroScope: number;
}

/**
 * The pre-create guards, in the order a caller can act on them.
 *
 * Emptiness is checked first and separately: stdin arriving unread is byte-identical to stdin
 * arriving empty, so a bodyless child would otherwise be filed as a successful one (the `report`
 * precedent). The two shape guards follow, then the trace.
 */
export const checkChildInput = (
	opts: {readonly body: string; readonly stories: ReadonlyArray<number>},
	codes: ChildCodes,
): ChildRefusal | null => {
	if (opts.body.trim() === "") {
		return {code: codes.empty, message: "empty body on stdin — refusing to file a bodyless child"};
	}
	if (!hasSpec(opts.body)) {
		return {
			code: codes.malformed,
			message: "no `### What to build` section — a picker would have to infer the work from the title",
		};
	}
	if (criteriaCount(opts.body) === 0) {
		return {
			code: codes.malformed,
			message:
				"no acceptance criterion — a child without one is picked up anyway, and the agent that picks it decides for itself what done meant",
		};
	}
	if (opts.stories.length === 0) {
		return {
			code: codes.zeroScope,
			message: "no story trace — a child no story asks for is work nobody agreed to",
		};
	}
	return null;
};

/**
 * The child body as it is filed: the trace line first, then the caller's spec.
 *
 * The trace goes above rather than below because it is what `epic-ledger` parses and what a human
 * skimming the child needs first — it answers "why does this exist" before "what is it".
 */
export const composeChild = (opts: {
	readonly epic: number;
	readonly stories: ReadonlyArray<number>;
	readonly body: string;
}): string =>
	[
		`${STORIES_PREFIX} ${opts.stories.map((s) => `#${s}`).join(", ")}`,
		`**Epic:** #${opts.epic}`,
		"",
		opts.body.replace(/\s+$/, ""),
		"",
	].join("\n");

/**
 * Title normalisation for the create-once key.
 *
 * Case and inner whitespace are collapsed because a re-emitted step can differ in both without
 * being a different child, and a byte-equality key would file the twin the guard exists to prevent.
 * Nothing else is normalised: two titles that differ in a word are two children.
 */
export const childKey = (title: string): string => title.trim().toLowerCase().replace(/\s+/g, " ");

/** The existing child matching `title`, or null. Create-once is keyed on this, not on the body. */
export const matchExisting = <T extends {readonly title: string}>(
	existing: ReadonlyArray<T>,
	title: string,
): T | null => existing.find((c) => childKey(c.title) === childKey(title)) ?? null;

/**
 * The brief an epic body carries: everything above the first section this stage writes.
 *
 * `plan-epic` appends below the brief and never rewrites over it, so "the brief" is defined by
 * where the planner's own sections start. Comparing this slice before and after the write is the
 * proof the write preserved it.
 */
export const briefOf = (body: string): string => {
	const m = /^##\s+(?:Plan \(plan-epic\)|Dependencies)\s*$/m.exec(body);
	return (m ? body.slice(0, m.index) : body).replace(/\s+$/, "");
};

/**
 * Is this the epic's first plan — no section this stage writes exists yet?
 *
 * The distinction matters because the splice reads a plan block as a *re-plan* signal, and a
 * re-plan requires the sections it replaces to already be there. On a first plan there is nothing
 * to replace: both blocks are new, and both are appended. Deciding this from the **body** rather
 * than from whether the caller passed a plan file is what keeps a first plan from being refused as
 * a corrupt re-plan.
 */
export const isFirstPlan = (body: string): boolean =>
	!/^##[^\S\n]+Dependencies[^\S\n]*$/m.test(body) &&
	!/^##[^\S\n]+Plan \(plan-epic\)[^\S\n]*$/m.test(body);

/**
 * Where two briefs first diverge, or null when they are identical.
 *
 * The index alone is not enough to act on: a planner told only "the brief changed" has to diff two
 * issue bodies by hand to find out what it destroyed, and will not.
 */
export const briefDivergence = (
	before: string,
	after: string,
): {readonly index: number; readonly expected: string; readonly actual: string} | null => {
	if (before === after) return null;
	let i = 0;
	while (i < before.length && i < after.length && before[i] === after[i]) i += 1;
	const window = 60;
	return {
		index: i,
		expected: before.slice(i, i + window),
		actual: after.slice(i, i + window),
	};
};
