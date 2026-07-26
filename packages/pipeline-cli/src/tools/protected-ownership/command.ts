import {readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {classifyOwnership, parseCodeowners, verifyOwnership} from "./protected-ownership.ts";
import {readProtectedOwnershipPolicy, repositoryRoot} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/agent-policy.json (default: current Git root)"));
const policyRefFlag = Flag.string("policy-ref").pipe(Flag.optional, Flag.withDescription("immutable Git ref whose agent policy is authoritative (default: worktree policy)"));
const filesFromFlag = Flag.string("files-from").pipe(Flag.optional, Flag.withDescription("newline-delimited changed paths (default: stdin)"));
const approversFromFlag = Flag.string("approvers-from").pipe(Flag.optional, Flag.withDescription("newline-delimited current-revision approver identities for verify"));
const rootOf = (root: Option.Option<string>): string | null => { const requested = Option.getOrUndefined(root); return requested === undefined ? repositoryRoot() : resolve(requested); };
const lines = (path: Option.Option<string>, stdin = false): ReadonlyArray<string> | null => { try { const raw = Option.match(path, {onSome: (value) => readFileSync(value, "utf8"), onNone: () => stdin ? readFileSync(0, "utf8") : ""}); return raw.split("\n").map((value) => value.trim()).filter(Boolean); } catch { return null; } };

const evaluate = (root: Option.Option<string>, policyRef: Option.Option<string>, filesFrom: Option.Option<string>) => {
	const resolvedRoot = rootOf(root);
	if (resolvedRoot === null) return {error: "repository root could not be resolved", code: 2 as const};
	const loaded = readProtectedOwnershipPolicy(resolvedRoot, Option.getOrUndefined(policyRef) ?? null);
	if (!loaded.trusted || loaded.policy === null) return {error: `${loaded.reason ?? "policy is unavailable"} (${loaded.source})`, code: 2 as const};
	if (!loaded.policy.enabled) return {disabled: true as const, source: loaded.source};
	const changed = lines(filesFrom, true);
	if (changed === null) return {error: "changed paths could not be read", code: 2 as const};
	let rules = loaded.policy.rules;
	if (loaded.policy.source === "codeowners") {
		try { rules = parseCodeowners(readFileSync(join(resolvedRoot, loaded.policy.sourcePath!), "utf8")); }
		catch { return {error: `configured ownership source could not be read: ${loaded.policy.sourcePath}`, code: 2 as const}; }
	}
	return {classification: classifyOwnership(changed, rules, loaded.policy.source), policy: loaded.policy, source: loaded.source};
};

const classify = Command.make("classify", {root: rootFlag, policyRef: policyRefFlag, filesFrom: filesFromFlag}, Effect.fn(function* (args) {
	const result = evaluate(args.root, args.policyRef, args.filesFrom);
	if ("error" in result) { yield* Console.error(`protected-ownership: ${result.error}`); return yield* Effect.sync(() => process.exit(result.code)); }
	yield* Console.log(JSON.stringify("disabled" in result ? {status: "disabled", source: result.source} : {status: result.classification.kind, source: result.source, result: result.classification}));
	if (!("disabled" in result) && result.classification.kind === "indeterminate" && result.policy.enforcement === "blocking") return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Classify changed paths against an enabled repository-owned protected ownership mapping"));

const verify = Command.make("verify", {root: rootFlag, policyRef: policyRefFlag, filesFrom: filesFromFlag, approversFrom: approversFromFlag}, Effect.fn(function* (args) {
	const result = evaluate(args.root, args.policyRef, args.filesFrom);
	if ("error" in result) { yield* Console.error(`protected-ownership: ${result.error}`); return yield* Effect.sync(() => process.exit(result.code)); }
	if ("disabled" in result) return yield* Console.log(JSON.stringify({status: "disabled", source: result.source}));
	const approvers = lines(args.approversFrom);
	if (approvers === null || Option.isNone(args.approversFrom)) { yield* Console.error("protected-ownership: --approvers-from is required to verify current-revision ownership evidence"); return yield* Effect.sync(() => process.exit(2)); }
	const verdict = verifyOwnership(result.classification, approvers);
	yield* Console.log(JSON.stringify({status: verdict.pass ? "pass" : "missing-ownership-evidence", enforcement: result.policy.enforcement, source: result.source, result: verdict}));
	if (!verdict.pass && result.policy.enforcement === "blocking") return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Verify caller/provider-supplied current-revision ownership evidence for affected protected paths"));

export const protectedOwnershipCommand = Command.make("protected-ownership").pipe(Command.withSubcommands([classify, verify]), Command.withDescription("Optional protected ownership adapter; disabled until a repository supplies a source and owner syntax"));
