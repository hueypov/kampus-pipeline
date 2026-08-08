/**
 * The `plan-epic` tool — the two verbs `skills/plan-epic/SKILL.md` calls that had none.
 *
 * Implements the derived contract at
 * `claude-plugins/pipeline/skills/plan-epic/contract.md`. The lock (`epic-lock`), the pure
 * splice transform (`epic-splice`), and the structural gate (`epic-ledger`) already existed; what
 * was left in the skill's prose was the child shape and the read-modify-write around the transform.
 *
 * Both verbs are shaped by the same rule: a step whose failure is silent gets its own exit code.
 * `child` separates "the body is malformed" from "the plan traced this child to nothing" because
 * the first is the caller's text and the second is the caller's plan. `write` separates "the write
 * outcome is unknown" from "the write landed and ate the brief" because the first may be safe to
 * retry and the second is damage that retrying compounds.
 */
import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {spliceEpicBody} from "../epic-splice/epic-splice.ts";
import {GithubTrackerLive, Tracker} from "../tracker/tracker.ts";
import {
	briefDivergence,
	briefOf,
	checkChildInput,
	composeChild,
	isFirstPlan,
	matchExisting,
} from "./child.ts";
import * as Exit from "../../exit-codes.ts";

const CODES = {empty: Exit.EMPTY_INPUT, malformed: Exit.MALFORMED_INPUT, zeroScope: Exit.ZERO_SCOPE};

/** What a plan child may be. `epic` is absent deliberately — see the refusal message. */
const CHILD_TYPES = ["bug", "feature", "chore", "decision", "investigation"];

const refuse = (verb: string, message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`plan-epic ${verb}: ${message}\n`);
		process.exit(code);
	});

const readStdin = (): string => {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
};

const readTextFile = (path: string): string | null => {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

const epicArg = Argument.integer("epic").pipe(
	Argument.withDescription("the epic issue the verb acts on"),
);

const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("validate and print what would be written; change nothing"),
);

/**
 * A tracker read that failed is UNKNOWN, and every caller below routes it to
 * `PRECONDITION_UNKNOWN`. Collapsing it into a generic failure is what would let "could not list
 * the epic's children" be acted on as "the epic has no children".
 */
const unreadable = (verb: string, what: string) => ({
	"gh-io/GhCommandError": () =>
		refuse(verb, `could not read ${what} — the read failed, so the answer is UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
	"gh-io/GhParseError": () =>
		refuse(verb, `could not parse ${what} — the answer is UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
	"gh-io/RepoResolutionError": () =>
		refuse(verb, `target repo unresolved — ${what} is UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
	SchemaError: () =>
		refuse(verb, `${what} did not decode — the answer is UNKNOWN`, Exit.PRECONDITION_UNKNOWN),
});

/** The same set, routed to WRITE_UNKNOWN: a write whose outcome could not be read is not a failure. */
const unconfirmed = (verb: string, what: string) => ({
	"gh-io/GhCommandError": () => refuse(verb, `${what} — the outcome is UNKNOWN`, Exit.WRITE_UNKNOWN),
	"gh-io/GhParseError": () => refuse(verb, `${what} — the outcome is UNKNOWN`, Exit.WRITE_UNKNOWN),
	"gh-io/RepoResolutionError": () => refuse(verb, `${what} — the outcome is UNKNOWN`, Exit.WRITE_UNKNOWN),
	SchemaError: () => refuse(verb, `${what} — the outcome is UNKNOWN`, Exit.WRITE_UNKNOWN),
});

// ── child ────────────────────────────────────────────────────────────────────

const titleFlag = Flag.string("title").pipe(
	Flag.withDescription("the child's title; also the create-once key"),
);

const storiesFlag = Flag.string("stories").pipe(
	Flag.withDescription("the plan's story numbers this child implements, comma-separated"),
);

/**
 * A plan child is born **triaged**, not queued for triage.
 *
 * It has already been classified — by the plan that produced it, under a lock, by an agent that
 * read the codebase. Filing it into the intake queue would ask a triager to re-derive a
 * classification the planner already made, and `epic-ledger` fails a ledger whose children still
 * carry the intake label, so the queue round-trip is not merely wasteful: it makes the plan invalid
 * until somebody undoes it.
 */
const typeFlag = Flag.string("type").pipe(
	Flag.withDescription("the child's classification: bug|feature|chore|decision|investigation"),
);

const priorityFlag = Flag.string("priority").pipe(
	Flag.withDefault("p2"),
	Flag.withDescription("the child's priority band (default: p2)"),
);

const parseStories = (raw: string): ReadonlyArray<number> =>
	raw
		.split(",")
		.map((s) => Number.parseInt(s.trim().replace(/^#/, ""), 10))
		.filter((n) => Number.isInteger(n) && n > 0);

const child = Command.make(
	"child",
	{
		epic: epicArg,
		title: titleFlag,
		stories: storiesFlag,
		type: typeFlag,
		priority: priorityFlag,
		dryRun: dryRunFlag,
	},
	Effect.fn(function* ({epic, title, stories, type, priority, dryRun}) {
		const body = readStdin();
		const storyNumbers = parseStories(stories);
		const refusal = checkChildInput({body, stories: storyNumbers}, CODES);
		if (refusal) return yield* refuse("child", refusal.message, refusal.code);
		if (!CHILD_TYPES.includes(type)) {
			return yield* refuse(
				"child",
				`unknown type '${type}' — a child must be one of ${CHILD_TYPES.join(", ")}. 'epic' is not among them: a child that is itself an epic is a plan that did not finish.`,
				Exit.MALFORMED_INPUT,
			);
		}

		const composed = composeChild({epic, stories: storyNumbers, body});
		if (dryRun) return yield* Console.log(composed);

		const tracker = yield* Tracker;
		// Create-once BEFORE the create, keyed on the title. A retry or a re-emitted step is
		// otherwise a byte-identical twin, and two children for one unit is the specific damage.
		const existing = yield* tracker
			.listSubIssues(epic)
			.pipe(Effect.catchTags(unreadable("child", `the children of #${epic}`)));
		const already = matchExisting(existing, title);
		if (already) {
			return yield* Console.log(`plan-epic: reusing #${already.number} — ${already.title}`);
		}

		const created = yield* tracker
			.createIssue({title, body: composed, stage: "triaged"})
			.pipe(Effect.catchTags(unreadable("child", "the create response")));

		// The classification the plan already made, stamped now rather than left for a triager to
		// re-derive. `epic-ledger` fails a ledger whose children lack a type or priority, so this is
		// part of filing a child, not a follow-up step someone could skip.
		yield* tracker
			.applyTriage(created.target, {
				type,
				priority,
				status: "triaged",
				readyFor: "agent",
			})
			.pipe(
				Effect.catchTags(
					unconfirmed(
						"child",
						`filed #${created.target} and could not stamp its classification. The issue EXISTS — re-running is safe (create-once matches on the title)`,
					),
				),
			);

		// The issue exists from here on, so every failure below must say so — a message that reads
		// like "nothing happened" invites a retry that would file a second one.
		const filed = `filed #${created.target} and the link is UNKNOWN. The issue EXISTS — re-running is safe (create-once matches on the title) and will retry the link`;
		yield* tracker.linkSubIssue(epic, created.target).pipe(
			Effect.catchTags({
				"tracker/TrackerVerifyError": (e: {readonly message: string}) =>
					refuse(
						"child",
						`filed #${created.target} and ${e.message}. The issue EXISTS — re-running is safe (create-once matches on the title) and will retry the link.`,
						Exit.WRITE_UNKNOWN,
					),
				...unconfirmed("child", filed),
			}),
		);
		yield* Console.log(`plan-epic: filed #${created.target} — ${title}`);
	}),
).pipe(
	Command.withDescription(
		"File one sub-issue of an epic and link it — refuses a child with no acceptance criterion or no story trace; create-once on the title",
	),
);

// ── write ────────────────────────────────────────────────────────────────────

const depsFileFlag = Flag.string("deps-file").pipe(
	Flag.withDescription("path to the freshly-derived `## Dependencies` block"),
);

const planFileFlag = Flag.string("plan-file").pipe(
	Flag.optional,
	Flag.withDescription("path to the `## Plan (plan-epic)` block; its presence marks a re-plan"),
);

const write = Command.make(
	"write",
	{epic: epicArg, depsFile: depsFileFlag, planFile: planFileFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({epic, depsFile, planFile, dryRun}) {
		const deps = readTextFile(depsFile);
		if (deps === null) return yield* refuse("write", `cannot read ${depsFile}`, Exit.FAILED);
		if (deps.trim() === "") {
			return yield* refuse(
				"write",
				`${depsFile} is empty — refusing to pin a topology that says nothing`,
				Exit.EMPTY_INPUT,
			);
		}
		const planPath = Option.getOrUndefined(planFile);
		// `null` is the splice's own "first-time plan" signal, so an unreadable file must refuse
		// rather than fall through to it — a missing path would otherwise silently become a
		// first-time write that drops the plan section the caller asked to replace.
		const read = planPath === undefined ? null : readTextFile(planPath);
		if (planPath !== undefined && read === null) {
			return yield* refuse("write", `cannot read ${planPath}`, Exit.FAILED);
		}
		const plan: string | null = read;
		if (plan !== null && plan.trim() === "") {
			return yield* refuse(
				"write",
				`${planPath} is empty — refusing to replace a plan with nothing`,
				Exit.EMPTY_INPUT,
			);
		}

		const tracker = yield* Tracker;
		const before = yield* tracker
			.readIssue(epic)
			.pipe(Effect.catchTags(unreadable("write", `#${epic}`)));

		// A first plan appends both blocks; only a re-plan replaces. The splice reads a non-null
		// `plan` as the re-plan signal and refuses when the sections it would replace are absent, so
		// the first-plan case is resolved here — by appending the plan block to the body and handing
		// the splice an append — rather than by passing a signal that means something else.
		const first = isFirstPlan(before.body);
		const base =
			first && plan !== null ? `${before.body.replace(/\s+$/, "")}\n\n${plan.trim()}\n` : before.body;
		const outcome = spliceEpicBody({body: base, deps, plan: first ? null : plan});
		if (outcome._tag === "Corrupt") {
			return yield* refuse(
				"write",
				`${outcome.reason} — refusing to write rather than orphan or double a section`,
				Exit.MALFORMED_INPUT,
			);
		}
		if (dryRun) return yield* Console.log(outcome.body);

		const brief = briefOf(before.body);
		yield* tracker
			.replaceBody(epic, outcome.body)
			.pipe(Effect.catchTags(unconfirmed("write", `the body PATCH on #${epic} failed`)));

		// The read-back is the whole point of the verb. Without it the brief could be gone and the
		// verb would still report success — which is how a fleet ends up executing against a plan
		// whose approved input no longer exists.
		const after = yield* tracker
			.readIssue(epic)
			.pipe(Effect.catchTags(unreadable("write", `#${epic} after the write`)));
		const divergence = briefDivergence(brief, briefOf(after.body));
		if (divergence) {
			return yield* refuse(
				"write",
				`the write landed and the brief did NOT survive it — first divergence at byte ${divergence.index}\n  expected: ${JSON.stringify(divergence.expected)}\n  found:    ${JSON.stringify(divergence.actual)}`,
				Exit.READBACK_MISMATCH,
			);
		}
		yield* Console.log(
			`plan-epic: wrote #${epic} — brief preserved (${brief.length} bytes), dependencies ${outcome.mode === "append" ? "appended" : "replaced"}`,
		);
	}),
).pipe(
	Command.withDescription(
		"Splice the plan and dependency topology into the epic body and prove the brief survived byte for byte",
	),
);

export const planEpicCommand = Command.make("plan-epic").pipe(
	Command.withDescription(
		"Turn one triaged epic into an executable ledger: file its children, and write the plan without losing the brief",
	),
	Command.withSubcommands([child, write]),
	Command.provide(GithubTrackerLive),
);
