import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, statSync} from "node:fs";
import {join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {collectCssFacts, judge, renderReport} from "./design-token-guard.ts";
import {readDesignTokenPolicy} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/optional-workflow-policy.json (default: current Git root)"));
const repositoryRoot = (cwd = process.cwd()): string | null => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; } };
const escape = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
const globPattern = (glob: string): RegExp => new RegExp(`^${glob.split("/").map((part) => part === "**" ? ".*" : part === "*" ? "[^/]+" : escape(part)).join("/")}$`);
const walk = (root: string, directory = ""): string[] => { let entries: string[]; try { entries = readdirSync(join(root, directory)); } catch { return []; } return entries.flatMap((entry) => { if (entry === ".git" || entry === "node_modules" || entry === "dist") return []; const relative = directory ? `${directory}/${entry}` : entry; try { return statSync(join(root, relative)).isDirectory() ? walk(root, relative) : [relative]; } catch { return []; } }); };
const check = Command.make("check", {root: rootFlag}, Effect.fn(function* ({root}) {
	const requested = Option.getOrUndefined(root); const resolvedRoot = requested === undefined ? repositoryRoot() : resolve(requested);
	if (resolvedRoot === null) { yield* Console.error("design-token-guard: repository root could not be resolved — enabled policy cannot be evaluated"); return yield* Effect.sync(() => process.exit(2)); }
	const loaded = readDesignTokenPolicy(resolvedRoot);
	if (!loaded.trusted || loaded.policy === null) { yield* Console.error(`design-token-guard: ${loaded.reason ?? "policy is unavailable"} (${loaded.source})`); return yield* Effect.sync(() => process.exit(2)); }
	if (!loaded.policy.enabled) { yield* Console.log(`design-token-guard: disabled by repository policy (${loaded.source})`); return; }
	const patterns = loaded.policy.sourceGlobs.map(globPattern); const paths = walk(resolvedRoot).filter((path) => patterns.some((pattern) => pattern.test(path))).sort();
	const files = [];
	for (const path of paths) { try { files.push(collectCssFacts(path, readFileSync(join(resolvedRoot, path), "utf8"), loaded.policy.rule)); } catch { yield* Console.error(`design-token-guard: configured source could not be read: ${path}`); return yield* Effect.sync(() => process.exit(2)); } }
	const verdict = judge(files, loaded.policy.rule); const report = renderReport(verdict);
	if (verdict.pass) { yield* Console.log(report); return; }
	yield* Console.error(report); return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Check an explicitly enabled, repository-configured CSS custom-property token policy without changing source files"));
export const designTokenGuardCommand = Command.make("design-token-guard").pipe(Command.withSubcommands([check]), Command.withDescription("Optional, policy-owned design-token guard; disabled unless a repository explicitly supplies its source format and rules"));
