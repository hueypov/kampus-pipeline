/**
 * The `evals` tool — the static gate on an eval set, before anyone spends a model run on it.
 *
 * `lint` is the deterministic half of eval quality. It cannot tell whether a case's premise is true
 * or whether the skill can do what an assertion demands — those need a run — but it does decide the
 * failures that are mechanically visible, and those are the ones that make a green run meaningless.
 *
 * `tier` prints the derived execution tier per case, so the split between what a machine can check
 * and what needs a grader is readable without running anything.
 */
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {Console, Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import * as Exit from "../../exit-codes.ts";
import {deriveTier, lintEvalSet, renderFindings, type EvalCase, type EvalSet} from "./evals.ts";

const SKILLS = "claude-plugins/kampus-pipeline/skills";

const refuse = (verb: string, message: string, code: number): Effect.Effect<never> =>
	Effect.sync(() => {
		process.stderr.write(`evals ${verb}: ${message}\n`);
		process.exit(code);
	});

const skillArg = Argument.string("skill").pipe(
	Argument.withDescription("the skill whose eval set to read"),
);

const rootFlag = Flag.string("root").pipe(
	Flag.withDefault("."),
	Flag.withDescription("repository root to resolve the skill under (default: .)"),
);

const ambientFlag = Flag.string("ambient").pipe(
	Flag.optional,
	Flag.withDescription(
		"path to the standing instructions a baseline run already reads (default: CLAUDE.md at the root, when present)",
	),
);

interface Loaded {
	readonly set: EvalSet;
	readonly cases: ReadonlyArray<EvalCase>;
}

const loadSet = (root: string, skill: string, verb: string): Effect.Effect<Loaded> =>
	Effect.gen(function* () {
		const path = join(root, SKILLS, skill, "evals", "evals.json");
		if (!existsSync(path)) {
			// A skill with no eval set is UNKNOWN, not clean. Reporting "no findings" for a set that
			// does not exist is the vacuous pass this whole tool exists to refuse.
			return yield* refuse(
				verb,
				`no eval set at ${path} — the skill is ungraded, which is not the same as passing`,
				Exit.GATE_MISSING,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			return yield* refuse(verb, `${path} is not valid JSON — ${String(error)}`, Exit.MALFORMED_INPUT);
		}
		const set = parsed as EvalSet;
		return {set, cases: Array.isArray(set.evals) ? (set.evals as ReadonlyArray<EvalCase>) : []};
	});

const readAmbient = (root: string, override: Option.Option<string>): string => {
	const path = Option.getOrElse(override, () => join(root, "CLAUDE.md"));
	return existsSync(path) ? readFileSync(path, "utf8") : "";
};

const lint = Command.make(
	"lint",
	{skill: skillArg, root: rootFlag, ambient: ambientFlag},
	Effect.fn(function* ({skill, root, ambient}) {
		const {set} = yield* loadSet(root, skill, "lint");
		const ambientText = readAmbient(root, ambient);
		const findings = lintEvalSet(set, {skill, ambient: ambientText});

		if (ambientText === "") {
			// Say so rather than let a skipped check read as a passed one.
			yield* Console.error(
				"evals lint: no ambient context found — the grades-the-repository check did NOT run",
			);
		}

		if (findings.length === 0) {
			yield* Console.log(`evals lint: ${skill} — clean (${(set.evals as unknown[]).length} case(s))`);
			return;
		}
		yield* Console.log(`evals lint: ${skill} — ${findings.length} finding(s)`);
		yield* Console.log(renderFindings(findings));
		if (findings.some((f) => f.severity === "defect")) {
			return yield* refuse("lint", `${skill} has defects that make a green run meaningless`, Exit.GATE_FAIL);
		}
	}),
).pipe(
	Command.withDescription(
		"Check an eval set for the failures that make a green run meaningless — exit 14 on a defect, 0 with risks only",
	),
);

const tier = Command.make(
	"tier",
	{skill: skillArg, root: rootFlag},
	Effect.fn(function* ({skill, root}) {
		const {cases} = yield* loadSet(root, skill, "tier");
		for (const [index, testCase] of cases.entries()) {
			const assertions = Array.isArray(testCase.assertions)
				? (testCase.assertions as unknown[]).filter((a): a is string => typeof a === "string")
				: [];
			const name = typeof testCase.name === "string" ? testCase.name : `#${index + 1}`;
			yield* Console.log(`${deriveTier(assertions)}\t${name}`);
		}
	}),
).pipe(
	Command.withDescription(
		"Print each case's derived execution tier — graded unless every assertion names an observable",
	),
);

export const evalsCommand = Command.make("evals").pipe(
	Command.withDescription(
		"The static gate on a skill's eval set: what can be decided about eval quality without spending a model run",
	),
	Command.withSubcommands([lint, tier]),
);
