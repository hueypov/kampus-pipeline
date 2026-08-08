/**
 * The pure core for `evals` — the static checks an eval set must pass before anyone runs it.
 *
 * IO-free. This exists because an eval that measures the wrong thing is worse than no eval: it
 * reports green and buys confidence it did not earn. The checks below are the mechanically-decidable
 * subset of the ways an eval set can be hollow, each one a defect shape observed in practice rather
 * than imagined:
 *
 *  - **It grades the repository, not the skill.** If an assertion restates something the ambient
 *    context already says, a run that read only the ambient context satisfies it. The eval then
 *    proves the model read CLAUDE.md, which it would have done anyway.
 *  - **The baseline arm cannot run.** A prompt written as `/<skill>` names the skill, so the
 *    without-skill arm is unrunnable — and the with/without comparison is the only thing that makes
 *    an eval mean anything. A case meant for both arms is written as plain task text.
 *  - **An assertion cannot fail cleanly.** Two claims joined into one assertion pass or fail
 *    together, so a half-right run is recorded as wholly wrong or wholly right.
 *
 * What this file does NOT decide is whether a case's premise is true, or whether the skill can even
 * do what the assertion demands. Those need the repository and a run; they are not statically
 * decidable and are deliberately left to the runner and to review.
 */

export interface EvalCase {
	readonly id?: unknown;
	readonly name?: unknown;
	readonly grounding?: unknown;
	readonly prompt?: unknown;
	readonly assertions?: unknown;
}

export interface EvalSet {
	readonly skill_name?: unknown;
	readonly notes?: unknown;
	readonly evals?: unknown;
}

/** Where a finding sits on the fail/warn line. `defect` blocks; `risk` is for a human to judge. */
export type Severity = "defect" | "risk";

export interface Finding {
	readonly severity: Severity;
	readonly caseId: string;
	readonly rule: string;
	readonly detail: string;
}

/**
 * A case's execution tier, **derived from its assertions rather than declared**.
 *
 * The default is `graded`, and the asymmetry is deliberate: mis-deriving a judgment case as
 * mechanical reports an ungraded green, while the reverse only costs a model run. A declared field
 * would also drift from the assertions it describes; derivation cannot.
 */
export type Tier = "deterministic" | "graded";

/** Cues that an assertion names something a machine can observe without judging it. */
const OBSERVABLE = [
	/\bexit(?:s|ed)?\b[^.]{0,20}\b\d+\b/i,
	/\bexit (?:code|status)\b/i,
	/\bstdout\b|\bstderr\b/i,
	/`[^`]+`/,
	/\bnon-zero\b/i,
];

/** Does this one assertion name an observable? */
export const namesObservable = (assertion: string): boolean =>
	OBSERVABLE.some((re) => re.test(assertion));

/**
 * The tier for a whole case: mechanical only when EVERY assertion is mechanically checkable.
 * One judgment assertion makes the case graded, because a partially-mechanical run still needs the
 * grader to reach a verdict.
 */
export const deriveTier = (assertions: ReadonlyArray<string>): Tier =>
	assertions.length > 0 && assertions.every(namesObservable) ? "deterministic" : "graded";

/** Words that carry no discriminating power when comparing an assertion to ambient prose. */
const STOP = new Set([
	"the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for", "with", "is", "are", "be",
	"it", "its", "that", "this", "as", "by", "at", "from", "not", "does", "do", "than", "rather",
	"then", "when", "if", "into", "over", "only", "any", "all", "one", "no", "nor", "so",
]);

const tokens = (text: string): ReadonlyArray<string> =>
	text
		.toLowerCase()
		.replace(/`[^`]*`/g, " ")
		.split(/[^a-z0-9-]+/)
		.filter((w) => w.length > 2 && !STOP.has(w));

/**
 * How much of `assertion` is already present in one line of `ambient`, 0–1.
 *
 * Compared line by line rather than against the whole document: an assertion overlapping a document
 * *somewhere* proves nothing, since a long enough document contains most words. Overlapping a single
 * sentence is what indicates a restatement.
 */
export const ambientOverlap = (assertion: string, ambient: string): number => {
	const want = tokens(assertion);
	if (want.length === 0) return 0;
	let best = 0;
	for (const line of ambient.split(/\n|(?<=\.)\s+/)) {
		const have = new Set(tokens(line));
		if (have.size === 0) continue;
		const shared = want.filter((w) => have.has(w)).length;
		best = Math.max(best, shared / want.length);
	}
	return best;
};

/**
 * The share of an assertion's words that must appear in one ambient sentence before it is flagged.
 *
 * Set from the observed defect rather than by taste: a real confound was an assertion reading
 * "Does NOT ask the user for permission" against ambient text saying "don't ask permission,
 * don't propose-first" — a near-total restatement. A threshold this high flags restatements and
 * leaves assertions that merely share vocabulary alone, which matters because a false flag here
 * costs an author real work to dismiss.
 */
export const AMBIENT_RESTATEMENT = 0.8;

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);

const stringList = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];

/**
 * Lint one eval set against a skill name and the ambient context a baseline run would already have.
 *
 * `ambient` is what the without-skill arm reads anyway — the repository's standing instructions. Pass
 * an empty string to skip the confound check rather than to assert there is no ambient context; the
 * caller knows which it meant, and this cannot tell the difference.
 */
export const lintEvalSet = (
	set: EvalSet,
	options: {readonly skill: string; readonly ambient: string},
): ReadonlyArray<Finding> => {
	const findings: Finding[] = [];
	const cases = Array.isArray(set.evals) ? (set.evals as ReadonlyArray<EvalCase>) : [];

	if (cases.length === 0) {
		findings.push({
			severity: "defect",
			caseId: "-",
			rule: "empty-set",
			detail: "no eval cases — an empty set passes every run and measures nothing",
		});
		return findings;
	}

	const seen = new Set<string>();
	for (const [index, testCase] of cases.entries()) {
		const id = asString(testCase.name) ?? String(testCase.id ?? `#${index + 1}`);

		if (seen.has(id)) {
			findings.push({
				severity: "defect",
				caseId: id,
				rule: "duplicate-id",
				detail: "two cases share this identifier, so one result overwrites the other",
			});
		}
		seen.add(id);

		const prompt = asString(testCase.prompt) ?? "";
		if (prompt.trim() === "") {
			findings.push({severity: "defect", caseId: id, rule: "no-prompt", detail: "the case has no prompt"});
		}

		// A prompt naming the skill leaves the baseline arm nothing to run, and the with/without
		// comparison is the only thing that makes an eval measure the skill rather than the model.
		const invokes = new RegExp(`(^|\\s)/${set.skill_name ?? options.skill}\\b`).test(prompt);
		if (invokes) {
			findings.push({
				severity: "defect",
				caseId: id,
				rule: "skill-invoked-in-prompt",
				detail: `the prompt invokes /${options.skill}, so the without-skill arm cannot run — write it as plain task text`,
			});
		}

		if (asString(testCase.grounding) === null) {
			findings.push({
				severity: "risk",
				caseId: id,
				rule: "no-grounding",
				detail: "no grounding: nothing records which rule this case defends, so a later edit cannot tell whether it still matters",
			});
		}

		const assertions = stringList(testCase.assertions);
		if (assertions.length === 0) {
			findings.push({
				severity: "defect",
				caseId: id,
				rule: "no-assertions",
				detail: "the case asserts nothing, so it cannot fail",
			});
			continue;
		}

		for (const assertion of assertions) {
			if (options.ambient !== "" && ambientOverlap(assertion, options.ambient) >= AMBIENT_RESTATEMENT) {
				findings.push({
					severity: "defect",
					caseId: id,
					rule: "ambient-restatement",
					detail: `"${assertion.slice(0, 70)}…" restates the ambient context, so a run that read only that satisfies it — this grades the repository, not the skill`,
				});
			}
			if (/\S\s+and\s+\S/i.test(assertion.replace(/`[^`]*`/g, ""))) {
				findings.push({
					severity: "risk",
					caseId: id,
					rule: "compound-assertion",
					detail: `"${assertion.slice(0, 70)}…" may join two claims, which pass or fail together — a half-right run records as wholly one or the other`,
				});
			}
		}
	}
	return findings;
};

/** Render findings for a terminal, defects first. An empty list prints nothing; the caller says so. */
export const renderFindings = (findings: ReadonlyArray<Finding>): string =>
	[...findings]
		.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "defect" ? -1 : 1))
		.map((f) => `  ${f.severity === "defect" ? "✗" : "!"} ${f.rule} (${f.caseId}) — ${f.detail}`)
		.join("\n");
