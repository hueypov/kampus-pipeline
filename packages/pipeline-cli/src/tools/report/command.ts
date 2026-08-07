/**
 * The `report` tool — `pipeline-cli report dedup --query "<text>"`.
 *
 * Implements the derived contract at
 * `claude-plugins/kampus-pipeline/skills/report/contract.md`. `dedup` is complete here; `file`
 * and `note` are specified in that contract and not yet built — they need an issue-body read-back
 * the `Tracker` service does not expose, and a verb that skipped it would be the
 * command-shaped stub that silently passes.
 *
 * What this adds over `intake-dedup check`, whose ranking core it reuses rather than copies:
 *
 *  - **The outcome is the first stdout line**, one of `candidates` / `none` / `indeterminate`.
 *    `intake-dedup` prints nothing on stdout for both "nothing matched" and "your query had no
 *    usable keywords", leaving them separable only by reading a stderr string.
 *  - **`indeterminate` exits 3.** A check that did not discriminate must be impossible to read as
 *    "no duplicate found" at the exit-code level, not merely distinguishable on inspection.
 *  - **A failed source read exits 4**, so UNKNOWN is never reported as `none`.
 *  - **`--stage` is a flag**, so the intake queue is not a literal frozen in source.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {rankCandidates, tokenize} from "../intake-dedup/dedup-match.ts";
import {canDiscriminate} from "./body.ts";
import {Github, GithubLive} from "../intake-dedup/github.ts";

const DEFAULT_STAGE = "status:needs-triage";
const DEFAULT_LIMIT = 20;

const EXIT_INDETERMINATE = 3;
const EXIT_READ_FAILED = 4;

const queryFlag = Flag.string("query").pipe(
	Flag.withDescription(
		"the observation text (title plus distinguishing keywords) to check for an existing open issue",
	),
);

const excludeFlag = Flag.integer("exclude").pipe(
	Flag.optional,
	Flag.withDescription(
		"an issue number to omit from results — the issue being deduped, so it never flags itself",
	),
);

const limitFlag = Flag.integer("limit").pipe(
	Flag.withDefault(DEFAULT_LIMIT),
	Flag.withDescription(`maximum candidates to print (default: ${DEFAULT_LIMIT})`),
);

const stageFlag = Flag.string("stage").pipe(
	Flag.withDefault(DEFAULT_STAGE),
	Flag.withDescription(
		`the lifecycle stage whose queue is the read-after-write source (default: ${DEFAULT_STAGE})`,
	),
);

/** Print a refusal on stderr and exit with its code — the "this is not an answer" path. */
const refuse = (message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`report dedup: ${message}\n`);
		process.exit(code);
	});

const check = Command.make(
	"dedup",
	{query: queryFlag, exclude: excludeFlag, limit: limitFlag, stage: stageFlag},
	Effect.fn(function* ({query, exclude, limit, stage}) {
		const tokens = tokenize(query);
		// Too few distinctive tokens and the search half matches everything while the queue half
		// matches nothing — so nothing was actually compared. That is a non-check, and it exits
		// non-zero precisely so a caller cannot act on it as if it were a clean `none`.
		if (!canDiscriminate(tokens)) {
			return yield* refuse(
				`too few distinctive keywords in --query (${tokens.length}: [${tokens.join(" ")}]) — nothing was compared`,
				EXIT_INDETERMINATE,
			);
		}

		const gh = yield* Github;
		// A source that could not be read makes the answer UNKNOWN. Letting it fall through to a
		// generic non-zero exit would be survivable; printing `none` would not, which is why this
		// resolves to its own code rather than sharing one with a usage error.
		const unknown = (reason: string) =>
			refuse(`could not read a source (${reason}) — outcome UNKNOWN`, EXIT_READ_FAILED);
		const [queue, search] = yield* Effect.all([gh.queue(stage), gh.search(tokens)], {
			concurrency: "unbounded",
		}).pipe(
			Effect.catchTags({
				"@kampus/intake-dedup/GhCommandError": (e) => unknown(`gh exited ${e.exitCode}`),
				"@kampus/intake-dedup/GhParseError": (e) => unknown(e.message),
				"@kampus/intake-dedup/RepoResolutionError": () => unknown("target repo unresolved"),
			}),
		);

		const candidates = rankCandidates({
			queue,
			search,
			tokens,
			exclude: Option.getOrUndefined(exclude),
			limit,
		});

		if (candidates.length === 0) {
			yield* Console.log("none");
			process.stderr.write(`report dedup: 0 candidates for [${tokens.join(" ")}]\n`);
			return;
		}
		yield* Console.log("candidates");
		for (const c of candidates) yield* Console.log(`#${c.number}\t${c.title}`);
		process.stderr.write(
			`report dedup: ${candidates.length} candidate(s) for [${tokens.join(" ")}]\n`,
		);
	}),
).pipe(
	Command.withDescription(
		"Is this observation already on the board? Prints the outcome (candidates|none|indeterminate) then any candidates; exit 3 = indeterminate (did not check), 4 = a source read failed",
	),
);

export const reportCommand = Command.make("report").pipe(
	Command.withSubcommands([check]),
	Command.withDescription(
		"The intake filing verbs. `dedup` answers whether an observation is already filed, separating a real 'none' from a check that never ran",
	),
	Command.provide(GithubLive),
);
