import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {Effect, Option} from "effect";
import {Argument, Command, Flag} from "effect/unstable/cli";
import {findRootDir} from "../../find-root-dir.ts";
import {type CheckFailed, checkReachability} from "./gate.ts";
import {readFeatureReachabilityPolicy} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: walk up from cwd)"));
const featureKeyArg = Argument.string("feature-key").pipe(Argument.withDescription("repository-defined feature/release key to verify"));
const defaultRoot = (from = process.cwd()): string => {
	const start = resolve(from);
	return findRootDir(start, (directory) => existsSync(join(directory, ".pipeline", "agent-policy.json")) || existsSync(join(directory, ".git")), dirname) ?? start;
};
const resolveRoot = (root: Option.Option<string>): string => Option.getOrElse(root, () => defaultRoot());
const fail = (message: string, code = 1) => Effect.sync(() => { process.stderr.write(`${message}\n`); process.exit(code); });

const check = Command.make("check", {featureKey: featureKeyArg, root: rootFlag}, Effect.fn(function* ({featureKey, root}) {
	const resolvedRoot = resolveRoot(root);
	const loaded = readFeatureReachabilityPolicy(resolvedRoot);
	if (!loaded.trusted || loaded.policy === null) return yield* fail(`reachability-guard: ${loaded.reason ?? "policy is unavailable"} (${loaded.source}) — refusing to evaluate an untrusted adapter`, 2);
	if (!loaded.policy.enabled) return yield* Effect.sync(() => process.stdout.write("reachability-guard: disabled by repository policy; no reachability gate was evaluated.\n"));
	yield* checkReachability(resolvedRoot, featureKey, loaded.policy).pipe(Effect.catchTag("CheckFailed", (error: CheckFailed) => fail(error.reason)));
})).pipe(Command.withDescription("Fail if an enabled repository-defined feature lacks a configured consumer or journey"));

export const reachabilityGuardCommand = Command.make("reachability-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Optional, policy-configured feature reachability gate; disabled safely until a repository supplies its own model"),
);
