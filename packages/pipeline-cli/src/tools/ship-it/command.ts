/**
 * The `ship-it` tool — `pipeline cli ship-it check` / `merge`.
 *
 * Implements the derived contract at
 * `claude-plugins/pipeline/skills/ship-it/contract.md`.
 *
 * `merge` re-runs every precondition immediately before merging rather than trusting an earlier
 * `check`. The head can move in between, and a verdict bound to the old head is not a verdict — a
 * check-then-merge sequence that trusted the earlier answer would reopen exactly the staleness hole
 * the gate contract exists to close.
 */
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {FAIL_CLOSED_POLICY} from "../class-probe/class-probe.ts";
import {readClassificationPolicy, repositoryRoot} from "../class-probe/policy.ts";
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
	gatesForFiles,
	parseGateList,
	mergeablePrecondition,
	ok,
	type Precondition,
} from "./preconditions.ts";

const exit = (verb: string, message: string, code: ExitCode): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`ship-it ${verb}: ${message}\n`);
		process.exit(code);
	});

/** The `pulls/N/files` page size the tracker reads with. At this count the list may be truncated. */
const FILE_PAGE = 100;

const prFlag = Flag.integer("pr").pipe(Flag.withDescription("the pull request to test"));

const gatesFlag = Flag.string("gates").pipe(
	Flag.optional,
	Flag.withDescription(
		"comma-separated gate namespaces this PR requires; default: derived from the PR's changed files",
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

/**
 * Refuse when the review scope itself could not be established.
 *
 * Distinct from a gate that is missing a verdict: that is a known requirement nobody met, while this
 * is not knowing what the requirement IS. Reporting it as "no gates required" is what let an
 * unreviewed PR pass.
 *
 * It shares `PRECONDITION_UNKNOWN` with the other could-not-read refusals, which is exactly what it
 * is — the scope is a precondition and it could not be read. There is deliberately no separate code
 * for "the diff genuinely requires no gate", because the classifier never returns that: an unmatched
 * path classifies as code, so only an empty file list reaches here, and a pull request that changes
 * nothing is anomalous rather than clean.
 */
const unknownScope = (pr: number, why: string, verb = "check"): Effect.Effect<never> =>
	exit(
		verb,
		`#${pr} scope: ${why} — which gates this PR requires is UNKNOWN, and unknown is not none`,
		EXIT.PRECONDITION_UNKNOWN,
	);

/**
 * Which gates this PR requires, derived from **what it changes**.
 *
 * This used to be derived from which gates already had a verdict — keep the gates whose state is not
 * `none`. That makes the requirement a function of the answer: a PR nobody reviewed has no verdicts,
 * therefore requires no gates, therefore passes. The merge authority returned exit 0 on an
 * unreviewed pull request, which is the one thing it exists to refuse (#60).
 *
 * The concern that produced it was real — a repository that never touches design must not be told it
 * is missing a `review-design` verdict — and classifying the diff answers it properly: a repository
 * with no design changes never classifies as design, so the gate is never required.
 *
 * Reading the diff is a precondition like any other here. A file list that cannot be read is UNKNOWN,
 * and an empty one is not "nothing to review" — a pull request that changes nothing is anomalous, and
 * treating it as clean is the same vacuous pass in a different costume.
 */
const requiredGates = (pr: number, named: Option.Option<string>) =>
	Effect.gen(function* () {
		// An explicit `--gates` is an assertion by the caller, and every named gate is required
		// whether or not a verdict exists. That is the difference between asserting the requirement
		// and discovering it.
		if (Option.isSome(named)) {
			const gates = parseGateList(named.value);
			if (gates === null) {
				return yield* unknownScope(
					pr,
					`--gates="${named.value}" names no gate this CLI has (valid: ${GATES.join(", ")}; the classification policy's "docs"/"skills" are "doc"/"skill" here)`,
				);
			}
			return gates;
		}

		const files = yield* (yield* Tracker).listPrFiles(pr).pipe(
			Effect.catchTags({
				"gh-io/GhCommandError": () => unknownScope(pr, "the changed-file list could not be read"),
				"gh-io/GhParseError": () => unknownScope(pr, "the changed-file list did not parse"),
				"gh-io/RepoResolutionError": () => unknownScope(pr, "the target repo did not resolve"),
				SchemaError: () => unknownScope(pr, "the changed-file list did not decode"),
			}),
		);
		if (files.length === 0) {
			return yield* unknownScope(pr, "it reports no changed files, so nothing can be classified");
		}
		// The file read takes one page. At exactly the page size the list is indistinguishable from a
		// truncated one, and a dropped path can drop the gate it would have required — a smaller diff
		// than the real one classifies to fewer gates, never more.
		if (files.length >= FILE_PAGE) {
			return yield* unknownScope(
				pr,
				`it reports ${files.length} changed files, the read's page size — the list may be truncated, so the required gates cannot be trusted`,
			);
		}

		const root = repositoryRoot();
		const policy = root === null ? null : readClassificationPolicy(root, null);
		// An unreadable policy classifies everything rather than nothing — the classifier's own
		// fail-closed default, reused here rather than re-decided.
		const gates = gatesForFiles(files, policy?.policy ?? FAIL_CLOSED_POLICY);
		if (gates === null) {
			return yield* unknownScope(pr, `${files.length} changed file(s) matched no review namespace`);
		}
		return gates;
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
