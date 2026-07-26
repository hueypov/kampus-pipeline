import {readFileSync} from "node:fs";
import {Console, Effect, Option, Result} from "effect";
import * as Schema from "effect/Schema";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {lintCorpus, isZeroScope, type ScanFile} from "./lint.ts";
import {DEFAULT_GH_COMPATIBILITY_POLICY, readGhCompatibilityPolicy, repositoryRoot} from "./policy.ts";

const FINDING_EXIT_CODE = 2;
const ZERO_SCOPE_EXIT_CODE = 3;

class FindingsFound extends Schema.TaggedErrorClass<FindingsFound>()("GhCompatFindingsFound", {count: Schema.Number}) {}
class ZeroScope extends Schema.TaggedErrorClass<ZeroScope>()("GhCompatZeroScope", {}) {}

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const filesArg = Argument.string("file").pipe(Argument.atLeast(1), Argument.withDescription("one or more skill or agent files to lint"));

const policyFor = (root: Option.Option<string>) => {
	const configuredRoot = Option.getOrUndefined(root) ?? repositoryRoot();
	if (configuredRoot === null) return DEFAULT_GH_COMPATIBILITY_POLICY;
	return readGhCompatibilityPolicy(configuredRoot);
};

const readFileOrSkip = (file: string): string | null => Result.getOrElse(Result.try(() => readFileSync(file, "utf8")), () => null);

const printLintResult = (name: string, result: ReturnType<typeof lintCorpus>) =>
	Effect.gen(function* () {
		yield* Console.log(`${name}: compatibility scan inspected ${result.scanned.length} file(s)${result.scanned.length ? ":" : " (zero scope)"}`);
		for (const file of result.scanned) yield* Console.log(`  scanned: ${file}`);
		yield* Console.log(`${name}: frontmatter scan inspected ${result.frontmatterScanned.length} file(s)${result.frontmatterScanned.length ? ":" : " (not enabled or zero scope)"}`);
		for (const file of result.frontmatterScanned) yield* Console.log(`  frontmatter-scanned: ${file}`);
	});

const lintSkills = Command.make(
	"lint-skills",
	{root: rootFlag, files: filesArg},
	Effect.fn(function* ({root, files}) {
		const policy = policyFor(root);
			if (policy === null) {
				yield* Console.error("gh-compat: invalid github.cliCompatibility policy — refusing lint because its scope rules are untrusted.");
			return yield* Effect.sync(() => process.exit(1));
		}
		const scanInput: ScanFile[] = [];
		for (const file of files) {
			const content = readFileOrSkip(file);
			if (content !== null) scanInput.push({file, content});
		}
		const result = lintCorpus(scanInput, policy);
		yield* printLintResult("gh-compat", result);
		const run = Effect.gen(function* () {
			if (isZeroScope(result, policy)) {
				yield* Console.error("gh-compat: FAIL — scanned zero required files; a no-op lint is not a clean lint.");
				return yield* Effect.fail(new ZeroScope());
			}
			const total = result.findings.length + result.frontmatterFindings.length;
			if (total === 0) {
				yield* Console.log("gh-compat: clean — configured gh compatibility rules and strict YAML frontmatter passed.");
				return;
			}
			for (const finding of result.findings) yield* Console.error(`  ${finding.file}:${finding.line}: ${finding.matched} — ${finding.reason}`);
			for (const finding of result.frontmatterFindings) yield* Console.error(`  ${finding.file}: invalid YAML frontmatter — ${finding.reason}`);
			return yield* Effect.fail(new FindingsFound({count: total}));
		});
		yield* run.pipe(
			Effect.catchTag("GhCompatZeroScope", () => Effect.sync(() => process.exit(ZERO_SCOPE_EXIT_CODE))),
			Effect.catchTag("GhCompatFindingsFound", () => Effect.sync(() => process.exit(FINDING_EXIT_CODE))),
		);
	}),
).pipe(Command.withDescription("Lint skills and agents for configured gh compatibility restrictions and strict YAML frontmatter; fail closed on zero scope"));

export const ghCompatCommand = Command.make("gh-compat").pipe(
	Command.withSubcommands([lintSkills]),
	Command.withDescription("Policy-configured GitHub CLI compatibility lint; the optional exact-argv shim is a separate toolkit-local executable"),
);
