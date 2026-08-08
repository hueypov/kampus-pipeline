/**
 * The `ship-it` tool — `pipeline cli ship-it check` / `merge`.
 *
 * Implements the derived contract at
 * `claude-plugins/kampus-pipeline/skills/ship-it/contract.md`.
 *
 * `merge` re-runs every precondition immediately before merging rather than trusting an earlier
 * `check`. The head can move in between, and a verdict bound to the old head is not a verdict — a
 * check-then-merge sequence that trusted the earlier answer would reopen exactly the staleness hole
 * the gate contract exists to close.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {GithubTrackerLive, Tracker} from "../tracker/tracker.ts";
import {Github as VerdictGithub, GithubLive as VerdictGithubLive} from "../verdict/github.ts";
import {GATES, type VerdictGate} from "../verdict/verdict-match.ts";
import {
	checksPrecondition,
	EXIT,
	type ExitCode,
	firstRefusal,
	type GateState,
	gatePrecondition,
	mergeablePrecondition,
	ok,
	type Precondition,
} from "./preconditions.ts";

const exit = (verb: string, message: string, code: ExitCode): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`ship-it ${verb}: ${message}\n`);
		process.exit(code);
	});

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the pull request to test"));

const gatesFlag = Flag.string("gates").pipe(
	Flag.optional,
	Flag.withDescription(
		"comma-separated gate namespaces this PR requires; default: every gate that has a verdict",
	),
);

/** Resolve one gate's state through the verdict reader, mapping every failure into a fact. */
const resolveGate = (pr: number, gate: VerdictGate): Effect.Effect<GateState, never, VerdictGithub> =>
	Effect.gen(function* () {
		const gh = yield* VerdictGithub;
		const result = yield* gh.read(pr, gate, "PASS", undefined);
		const o = result.outcome;
		if (o._tag === "none") return {_tag: "none"} as const;
		if (o._tag === "stale") return {_tag: "stale", sha: o.sha} as const;
		if (o._tag === "sha-less") return {_tag: "stale", sha: "unbound"} as const;
		return o.polarity === "PASS"
			? ({_tag: "pass", sha: result.headSha} as const)
			: ({_tag: "fail"} as const);
	}).pipe(
		// Any failure to READ a gate is a fact about our knowledge, not about the gate. It becomes
		// `unknown`, which refuses — never an absent verdict, which would read as "not required".
		Effect.option,
		Effect.map((o): GateState => (Option.isSome(o) ? o.value : {_tag: "unknown", reason: "read failed"})),
	);

/**
 * Every precondition for `pr`, in evaluation order.
 *
 * Order is deliberate: mergeability first because it is cheapest and most terminal, then the gates
 * (the thing the pipeline is actually for), then CI.
 */
const evaluate = (pr: number, gates: ReadonlyArray<VerdictGate>) =>
	Effect.gen(function* () {
		const tracker = yield* Tracker;
		const out: Array<Precondition> = [];

		const prState = yield* tracker.readPullRequest(pr).pipe(Effect.option);
		if (Option.isNone(prState)) {
			return [
				{
					name: "mergeable",
					ok: false as const,
					code: EXIT.PRECONDITION_UNKNOWN,
					detail: `could not read #${pr}`,
				},
			];
		}
		out.push(mergeablePrecondition(prState.value));
		if (firstRefusal(out)) return out;

		for (const gate of gates) out.push(gatePrecondition(gate, yield* resolveGate(pr, gate)));
		if (firstRefusal(out)) return out;

		const checks = yield* tracker.readChecks(prState.value.head).pipe(Effect.option);
		out.push(
			Option.isNone(checks)
				? {
						name: "checks",
						ok: false as const,
						code: EXIT.PRECONDITION_UNKNOWN,
						detail: "could not read check runs",
					}
				: checksPrecondition(checks.value),
		);
		return out;
	});

const parseGates = (raw: Option.Option<string>): ReadonlyArray<VerdictGate> => {
	const supplied = Option.getOrUndefined(raw);
	if (!supplied) return GATES;
	return supplied
		.split(",")
		.map((g) => g.trim().replace(/^review-/, ""))
		.filter((g): g is VerdictGate => (GATES as ReadonlyArray<string>).includes(g));
};

/**
 * Gates with no verdict at all are dropped from the required set when the caller did not name one.
 *
 * A repository that only ever runs `review-code` must not be told it is missing a `review-design`
 * verdict. When `--gates` IS given, every named gate is required and a missing verdict refuses —
 * that is the difference between discovering the requirement and asserting it.
 */
const requiredGates = (pr: number, named: Option.Option<string>) =>
	Effect.gen(function* () {
		const gates = parseGates(named);
		if (Option.isSome(named)) return gates;
		const present: Array<VerdictGate> = [];
		for (const gate of gates) {
			const state = yield* resolveGate(pr, gate);
			if (state._tag !== "none") present.push(gate);
		}
		return present;
	});

const report = (preconditions: ReadonlyArray<Precondition>) =>
	Effect.gen(function* () {
		for (const p of preconditions) {
			yield* Console.log(`${p.name.padEnd(20)} ${p.ok ? "ok     " : "REFUSED"} ${p.detail}`);
		}
	});

const check = Command.make(
	"check",
	{pr: prFlag, gates: gatesFlag},
	Effect.fn(function* ({pr, gates}) {
		const required = yield* requiredGates(pr, gates);
		yield* Console.log(`gates required: ${required.length === 0 ? "(none found)" : required.join(", ")}`);
		const preconditions = yield* evaluate(pr, required);
		yield* report(preconditions);
		const refusal = firstRefusal(preconditions);
		if (refusal) return yield* exit("check", `#${pr} ${refusal.name}: ${refusal.detail}`, refusal.code);
	}),
).pipe(
	Command.withDescription(
		"May this PR merge? Asserts current-head gate verdicts, CI, and mergeability; exits on the first refusal with the code naming its owner",
	),
);

const methodFlag = Flag.string("method").pipe(
	Flag.withDefault("squash"),
	Flag.withDescription("the merge method (default: squash)"),
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
	Flag.withDescription("run every precondition and report; merge nothing"),
);

const merge = Command.make(
	"merge",
	{pr: prFlag, gates: gatesFlag, method: methodFlag, dryRun: dryRunFlag},
	Effect.fn(function* ({pr, gates, method, dryRun}) {
		const required = yield* requiredGates(pr, gates);
		const preconditions = yield* evaluate(pr, required);
		const refusal = firstRefusal(preconditions);
		if (refusal) {
			yield* report(preconditions);
			return yield* exit("merge", `#${pr} ${refusal.name}: ${refusal.detail}`, refusal.code);
		}
		if (dryRun) {
			yield* report([...preconditions, ok("merge", "dry-run — nothing merged")]);
			return;
		}
		const tracker = yield* Tracker;
		// A merge that was requested but cannot be confirmed is its own outcome, never a success and
		// never a plain failure: retrying blindly is how one merge becomes two.
		const unconfirmed = exit(
			"merge",
			`#${pr} merge attempted; outcome UNCONFIRMED — do not retry blindly, read the PR`,
			EXIT.MERGE_UNKNOWN,
		);
		const merged = yield* tracker.mergePullRequest(pr, method).pipe(
			Effect.catchTag("tracker/TrackerVerifyError", (e) =>
				exit("merge", `${e.message} — do not retry blindly, read the PR`, EXIT.MERGE_UNKNOWN),
			),
			Effect.catchTags({
				"gh-io/GhCommandError": () => unconfirmed,
				"gh-io/GhParseError": () => unconfirmed,
				"gh-io/RepoResolutionError": () => unconfirmed,
			}),
		);
		yield* Console.log(`ship-it: merged #${pr} as ${merged.sha.slice(0, 7)}`);
	}),
).pipe(
	Command.withDescription(
		"Merge a verified PR, re-asserting every precondition immediately before the merge and proving the merge landed",
	),
);

export const shipItCommand = Command.make("ship-it").pipe(
	Command.withSubcommands([check, merge]),
	Command.withDescription(
		"The only stage with merge authority: assert the gates at the current head, then merge and prove it landed",
	),
	Command.provide(GithubTrackerLive),
	Command.provide(VerdictGithubLive),
);
