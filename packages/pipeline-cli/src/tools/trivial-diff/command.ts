import {readFileSync} from "node:fs";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {readLifecyclePolicy, repositoryRoot} from "../lifecycle-policy.ts";
import {classifyTrivialDiff} from "./trivial-diff.ts";

const diffFileFlag = Flag.string("diff-file").pipe(Flag.optional, Flag.withDescription("read a unified diff from this file instead of stdin"));

const readDiff = (path: Option.Option<string>): string | null => {
	try {
		return Option.match(path, {onSome: (file) => readFileSync(file, "utf8"), onNone: () => readFileSync(0, "utf8")});
	} catch {
		return null;
	}
};

const classify = Command.make(
	"classify",
	{diffFile: diffFileFlag},
	Effect.fn(function* ({diffFile}) {
		const root = repositoryRoot();
		const policy = root === null ? null : readLifecyclePolicy(root);
		const diff = readDiff(diffFile);
		if (policy === null || diff === null) {
			yield* Console.error(`trivial-diff: ${policy === null ? "repository lifecycle policy is unavailable" : "diff could not be read"} — default-deny`);
			yield* Console.log("non-trivial");
			return;
		}
		const result = classifyTrivialDiff(diff, policy.trivialDiff.maxChangedLines, policy.trivialDiff.protectedPaths);
		yield* Console.error(`trivial-diff: ${result.reason}`);
		yield* Console.log(result.verdict);
	}),
).pipe(Command.withDescription("Classify a unified diff as trivial or non-trivial; every uncertainty routes to full review"));

export const trivialDiffCommand = Command.make("trivial-diff").pipe(
	Command.withSubcommands([classify]),
	Command.withDescription("Fail-closed lightweight-review eligibility classifier; classification alone never changes gate routing"),
);
