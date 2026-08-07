/**
 * The pure core for the `report` verbs: everything about an intake body that can be decided
 * without touching the network.
 *
 * IO-free by construction. The `command.ts` shell reads stdin, calls in here, and only then
 * reaches the tracker — so every refusal below happens *before* any write, which is what makes
 * them refusals rather than cleanup.
 *
 * The leak predicate is NOT defined here. `findCommentLeaks` in `../leak-guard/leak-guard.ts`
 * already owns the pattern set, and a second definition beside it would drift from it the first
 * time either moved.
 */
import {findCommentLeaks, type Leak} from "../leak-guard/leak-guard.ts";

/**
 * The six sections of an intake body, in order. Type-blind by design: the same six fit a crash,
 * a refactor and a question, which is what lets a filer capture without classifying first.
 */
export const REQUIRED_SECTIONS = [
	"Summary",
	"What I was doing",
	"What I observed",
	"Why it matters",
	"Pointers",
	"Suggested next step (non-binding)",
] as const;

/** The one section allowed to be empty — a blank guess beats a misleading one. */
export const OPTIONAL_SECTION = "Suggested next step (non-binding)";

export type SectionDefect =
	| {readonly kind: "missing"; readonly section: string}
	| {readonly kind: "empty"; readonly section: string};

/** Heading text → the body between it and the next heading (or end). */
const splitSections = (body: string): ReadonlyMap<string, string> => {
	const out = new Map<string, string>();
	// Only `## ` headings delimit a section: a `###` inside one is content, and a fenced
	// block's `#` is not a heading at all.
	const lines = body.split("\n");
	let current: string | null = null;
	let buf: Array<string> = [];
	let fenced = false;
	const flush = () => {
		if (current !== null) out.set(current, buf.join("\n"));
	};
	for (const line of lines) {
		if (line.trimStart().startsWith("```")) fenced = !fenced;
		const heading = !fenced && /^##\s+(.+?)\s*$/.exec(line);
		if (heading) {
			flush();
			current = heading[1] ?? "";
			buf = [];
			continue;
		}
		if (current !== null) buf.push(line);
	}
	flush();
	return out;
};

/**
 * Every way the six-section contract can be broken, in section order.
 *
 * An empty result means the body is postable. A non-empty one is a refusal list, and the caller
 * reports the first entry — a filer fixes one thing at a time, and a wall of defects reads as a
 * broken tool rather than a correctable input.
 */
export const findSectionDefects = (body: string): ReadonlyArray<SectionDefect> => {
	const sections = splitSections(body);
	const defects: Array<SectionDefect> = [];
	for (const name of REQUIRED_SECTIONS) {
		if (!sections.has(name)) {
			defects.push({kind: "missing", section: name});
			continue;
		}
		if (name === OPTIONAL_SECTION) continue;
		if ((sections.get(name) ?? "").trim() === "") {
			defects.push({kind: "empty", section: name});
		}
	}
	return defects;
};

/**
 * Classification prefixes a title must not carry. Triage owns typing, and a hand-typed
 * classification is indistinguishable from a triaged one once it lands — which is precisely why
 * it has to be refused at the filing boundary rather than corrected later.
 */
const CLASSIFICATION_PREFIXES = [
	"bug",
	"feat",
	"feature",
	"chore",
	"fix",
	"security",
	"epic",
	"p0",
	"p1",
	"p2",
	"critical",
	"blocker",
] as const;

/** The offending prefix, or null when the title is type-neutral. */
export const classificationPrefix = (title: string): string | null => {
	const m = /^\s*([A-Za-z0-9]+)\s*:/.exec(title);
	if (!m) return null;
	const word = (m[1] ?? "").toLowerCase();
	return CLASSIFICATION_PREFIXES.includes(word as (typeof CLASSIFICATION_PREFIXES)[number])
		? (m[1] ?? null)
		: null;
};

/**
 * The fewest usable tokens a dedup query needs before its result means anything.
 *
 * Two is not enough. "it did the thing" survives tokenization as `did thing` — neither word is a
 * stopword and both clear the length floor — yet a two-generic-token query matches either nothing
 * or everything, and reporting `none` from it claims a check that did not happen. Raising the
 * stoplist instead would be endless: the defect is the *count* of discriminating terms, not which
 * particular words slipped through.
 */
export const MIN_DISCRIMINATING_TOKENS = 3;

/** Can this token set discriminate at all? False ⇒ the outcome is `indeterminate`, never `none`. */
export const canDiscriminate = (tokens: ReadonlyArray<string>): boolean =>
	tokens.length >= MIN_DISCRIMINATING_TOKENS;

/** Machine context for the provenance footer. Every field is best-effort. */
export interface FooterContext {
	readonly session?: string | undefined;
	readonly model?: string | undefined;
	readonly branch?: string | undefined;
	readonly timestamp: string;
}

/**
 * The provenance footer, which `triage` reads to decide what may be auto-closed: present means
 * agent-filed and therefore closable, absent means hand-typed and protected forever.
 *
 * `Filed by an agent` is the invariant — it is always emitted. Every other field is dropped when
 * the environment does not expose it, with no dangling label and no `unknown` placeholder, because
 * a footer full of `unknown` is a footer nobody reads. It carries no identity and no paths.
 */
export const composeFooter = (ctx: FooterContext): string => {
	const parts = ["Filed by an agent"];
	if (ctx.session) parts.push(`session \`${ctx.session}\``);
	if (ctx.model) parts.push(`model \`${ctx.model}\``);
	if (ctx.branch) parts.push(`branch \`${ctx.branch}\``);
	parts.push(ctx.timestamp);
	return `---\n<sub>${parts.join(" · ")}</sub>`;
};

/** Does this body already carry a provenance footer? Used to keep `file` idempotent on retry. */
export const hasFooter = (body: string): boolean => body.includes("Filed by an agent");

/** The body as it will be posted: sections, a blank line, then the footer. */
export const assembleBody = (body: string, footer: string): string =>
	`${body.replace(/\s+$/, "")}\n\n${footer}\n`;

export interface BodyRefusal {
	readonly code: 2;
	readonly message: string;
}

/**
 * Every pre-write guard for `report file`, in the order a filer can act on them: a body that never
 * arrived, then its shape, then the title, then leaks.
 *
 * Leaks come last on purpose — telling someone their path leaked is useless while the body is
 * still empty, and an unread stdin pipe is byte-identical to an empty one, so that check has to
 * come first or a body that never arrived files as a successful, bodyless issue.
 */
export const checkFileInput = (opts: {
	readonly title: string;
	readonly body: string;
	readonly redact: boolean;
}): BodyRefusal | null => {
	if (opts.body.trim() === "") {
		return {code: 2, message: "empty body on stdin — nothing to file"};
	}
	const defect = findSectionDefects(opts.body)[0];
	if (defect) {
		return defect.kind === "missing"
			? {code: 2, message: `missing required section '${defect.section}'`}
			: {code: 2, message: `section '${defect.section}' is empty`};
	}
	const prefix = classificationPrefix(opts.title);
	if (prefix) {
		return {
			code: 2,
			message: `title carries a classification prefix ('${prefix}') — type is triage's call`,
		};
	}
	return leakRefusal([opts.title, opts.body].join("\n"), opts.redact);
};

/** The `report note` guards: no section template, otherwise identical. */
export const checkNoteInput = (opts: {
	readonly body: string;
	readonly redact: boolean;
}): BodyRefusal | null => {
	if (opts.body.trim() === "") {
		return {code: 2, message: "empty body on stdin — nothing to add"};
	}
	return leakRefusal(opts.body, opts.redact);
};

/** Under `--redact` a leak is masked, not refused — the flag exists for when the path IS the evidence. */
const leakRefusal = (text: string, redact: boolean): BodyRefusal | null => {
	if (redact) return null;
	const leaks: ReadonlyArray<Leak> = findCommentLeaks(text);
	const first = leaks[0];
	return first
		? {
				code: 2,
				message: `machine-local path in body (${first.reason}) — fix it, or pass --redact if the path is the evidence`,
			}
		: null;
};
