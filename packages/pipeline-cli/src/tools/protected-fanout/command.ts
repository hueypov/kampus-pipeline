import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {judgeProtectedFanout} from "./protected-fanout.ts";
import {readProtectedFanoutPolicy, repositoryRoot} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("immutable Git ref whose agent policy is authoritative (default: worktree policy)"));
const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("newline-delimited changed paths (default: stdin)"));
const checksFromFlag = Flag.string("checks-from").pipe(Flag.optional, Flag.withDescription("newline-delimited completed validation/check identities"));
const rolesFromFlag = Flag.string("roles-from").pipe(Flag.optional, Flag.withDescription("newline-delimited satisfied review/role identities"));
const lines = (value: Option.Option<string>, stdin = false): ReadonlyArray<string> | null => { try { const text = Option.match(value, {onSome: (path) => readFileSync(path, "utf8"), onNone: () => stdin ? readFileSync(0, "utf8") : ""}); return text.split("\n").map((line) => line.trim()).filter(Boolean); } catch { return null; } };
const check = Command.make("check", {root: rootFlag, policyRef: policyRefFlag, filesFrom: filesFromFlag, checksFrom: checksFromFlag, rolesFrom: rolesFromFlag}, Effect.fn(function* ({root, policyRef, filesFrom, checksFrom, rolesFrom}) {
	const requested = Option.getOrUndefined(root); const resolvedRoot = requested === undefined ? repositoryRoot() : resolve(requested);
	if (resolvedRoot === null) { yield* Console.error("protected-fanout: repository root could not be resolved"); return yield* Effect.sync(() => process.exit(2)); }
	const loaded = readProtectedFanoutPolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
	if (!loaded.trusted || loaded.policy === null) { yield* Console.error(`protected-fanout: ${loaded.reason ?? "policy unavailable"} (${loaded.source})`); return yield* Effect.sync(() => process.exit(2)); }
	if (!loaded.policy.enabled) return yield* Console.log(JSON.stringify({status: "disabled", source: loaded.source}));
	const paths = lines(filesFrom, true); const checks = lines(checksFrom); const roles = lines(rolesFrom);
	if (paths === null || checks === null || roles === null) { yield* Console.error("protected-fanout: configured evidence input could not be read"); return yield* Effect.sync(() => process.exit(2)); }
	const verdict = judgeProtectedFanout(paths, checks, roles, loaded.policy.rules);
	yield* Console.log(JSON.stringify({status: verdict.pass ? "pass" : verdict.reason, enforcement: loaded.policy.enforcement, source: loaded.source, result: verdict}));
	if (!verdict.pass && loaded.policy.enforcement === "blocking") return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Check configured protected-change dependent artifacts, validations, and roles without mutation"));
export const protectedFanoutCommand = Command.make("protected-fanout").pipe(Command.withSubcommands([check]), Command.withDescription("Optional protected-change dependency/fan-out adapter; disabled until repository policy supplies its graph"));
