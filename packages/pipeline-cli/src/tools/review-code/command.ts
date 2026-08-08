/**
 * The `review-code` tool — `pipeline cli review-code brief`.
 *
 * Implements the derived contract at
 * `claude-plugins/pipeline/skills/review-code/contract.md`.
 *
 * One verb, and that is the finding rather than an omission. `review-code` is the mirror of
 * `ship-it`: that stage is almost entirely fact, so nearly all of it became verbs; this one is
 * almost entirely judgment, so almost none of it can. What is mechanical here is assembling the
 * reviewer's inputs — three reads that had to happen in the right order, of which the most-skipped
 * was the head the verdict binds to.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {Tracker, GithubTrackerLive} from "../tracker/tracker.ts";
import {acceptanceCriteria, closedIssue, renderBrief} from "./brief.ts";
import * as Exit from "../../exit-codes.ts";



const refuse = (message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`review-code brief: ${message}\n`);
		process.exit(code);
	});

const prFlag = Flag.integer("pr").pipe(
	Flag.withDescription("the pull request to assemble a brief for"),
);
const jsonFlag = Flag.boolean("json").pipe(
	Flag.withDescription("emit the brief as one object instead of prose"),
);

const brief = Command.make(
	"brief",
	{pr: prFlag, json: jsonFlag},
	Effect.fn(function* ({pr, json}) {
		const tracker = yield* Tracker;

		const prState = yield* tracker.readPullRequest(pr).pipe(Effect.option);
		if (Option.isNone(prState)) {
			return yield* refuse(`could not read #${pr} — UNKNOWN`, Exit.PRECONDITION_UNKNOWN);
		}

		const issue = closedIssue(prState.value.body);
		if (issue === null) {
			// write-code owns this seam — it opens PRs and composes the reference. Saying so keeps
			// the reviewer from inventing criteria, which would make it the author of the spec.
			return yield* refuse(
				`#${pr} has no closing reference — nothing to grade against`,
				Exit.ZERO_SCOPE,
			);
		}

		const issueState = yield* tracker.readIssue(issue).pipe(Effect.option);
		if (Option.isNone(issueState)) {
			return yield* refuse(`could not read #${issue} for #${pr} — UNKNOWN`, Exit.PRECONDITION_UNKNOWN);
		}

		const criteria = acceptanceCriteria(issueState.value.body);
		// A present-but-empty section refuses for the same reason a missing one does: an empty list
		// would let a PASS be earned by satisfying nothing. Triage owns making "done" legible.
		if (criteria === null || criteria.length === 0) {
			return yield* refuse(
				`#${pr} closes #${issue}, which has no acceptance criteria`,
				Exit.MALFORMED_INPUT,
			);
		}

		const files = yield* tracker.listPrFiles(pr).pipe(Effect.option);
		if (Option.isNone(files)) {
			return yield* refuse(`could not read changed files for #${pr} — UNKNOWN`, Exit.PRECONDITION_UNKNOWN);
		}

		const assembled = {
			head: prState.value.head,
			issue,
			issueTitle: issueState.value.title,
			criteria,
			files: files.value,
		};
		yield* Console.log(json ? JSON.stringify(assembled, null, 2) : renderBrief(assembled));
	}),
).pipe(
	Command.withDescription(
		"Everything the reviewer needs in one read: the head the verdict binds to, the linked issue, its acceptance criteria, and the changed paths",
	),
);

export const reviewCodeCommand = Command.make("review-code").pipe(
	Command.withSubcommands([brief]),
	Command.withDescription(
		"The code gate's one deterministic step. Grading the diff is judgment and stays in the skill",
	),
	Command.provide(GithubTrackerLive),
);
