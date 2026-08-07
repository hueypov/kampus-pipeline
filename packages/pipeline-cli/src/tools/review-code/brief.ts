/**
 * The pure core for `review-code brief`: finding the linked issue and its acceptance criteria.
 *
 * IO-free. Both are extractions with a wrong answer that matters — a missed closing reference makes
 * a gradeable PR ungradeable, and an over-eager criteria parse hands the reviewer a checklist the
 * issue never agreed to.
 */

/** The issue a PR closes, or null when it carries no closing reference. */
export const closedIssue = (prBody: string): number | null => {
	// Only the closing keywords count. A bare `#412` is a mention, and treating it as a close would
	// let a PR be graded against an issue nobody linked it to.
	const m = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i.exec(prBody);
	return m ? Number.parseInt(m[1] ?? "", 10) : null;
};

/**
 * The acceptance criteria in an issue body.
 *
 * Returns `null` when there is no criteria section at all, and `[]` when the section exists but
 * holds no items. The caller distinguishes them: a missing section and an empty one are both
 * refusals, but only the second means somebody wrote the heading and stopped.
 */
export const acceptanceCriteria = (issueBody: string): ReadonlyArray<string> | null => {
	const section = /^##+\s*Acceptance criteria\s*$/im.exec(issueBody);
	if (!section) return null;
	const rest = issueBody.slice(section.index + section[0].length);
	// Stop at the next heading of the same or higher level; anything past it belongs to another
	// section and is not something the author agreed to be graded on.
	const end = /^##+\s+/m.exec(rest);
	const body = end ? rest.slice(0, end.index) : rest;
	return body
		.split("\n")
		.map((line) => /^\s*[-*]\s*\[[ xX]\]\s*(.+?)\s*$/.exec(line)?.[1])
		.filter((c): c is string => typeof c === "string" && c.length > 0);
};

export interface Brief {
	readonly head: string;
	readonly issue: number;
	readonly issueTitle: string;
	readonly criteria: ReadonlyArray<string>;
	readonly files: ReadonlyArray<string>;
}

export const renderBrief = (b: Brief): string =>
	[
		`head:    ${b.head}`,
		`closes:  #${b.issue} — ${b.issueTitle}`,
		"criteria:",
		...b.criteria.map((c) => `  - [ ] ${c}`),
		"files:",
		...b.files.map((f) => `  ${f}`),
	].join("\n");
