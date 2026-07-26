import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync, statSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {buildInventory, renderInventory, type SourceFile} from "./design-inventory.ts";
import {readDesignInventoryPolicy} from "./policy.ts";
const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/optional-workflow-policy.json (default: current Git root)"));
const stdoutFlag = Flag.boolean("stdout").pipe(Flag.withDescription("print generated inventory instead of writing the configured descriptive artifact"));
const repositoryRoot = (cwd = process.cwd()): string | null => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; } };
const escape = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"); const globPattern = (glob: string): RegExp => new RegExp(`^${glob.split("/").map((part) => part === "**" ? ".*" : part === "*" ? "[^/]+" : escape(part)).join("/")}$`);
const walk = (root: string, directory = ""): string[] => { let entries: string[]; try { entries = readdirSync(join(root, directory)); } catch { return []; } return entries.flatMap((entry) => { if (entry === ".git" || entry === "node_modules" || entry === "dist") return []; const path = directory ? `${directory}/${entry}` : entry; try { return statSync(join(root, path)).isDirectory() ? walk(root, path) : [path]; } catch { return []; } }); };
const execute = (mode: "generate" | "check", root: Option.Option<string>, stdout: boolean) => Effect.fn(function* () {
	const requested = Option.getOrUndefined(root); const resolvedRoot = requested === undefined ? repositoryRoot() : resolve(requested);
	if (resolvedRoot === null) { yield* Console.error("design-inventory: repository root could not be resolved — enabled policy cannot be evaluated"); return yield* Effect.sync(() => process.exit(2)); }
	const loaded = readDesignInventoryPolicy(resolvedRoot); if (!loaded.trusted || loaded.policy === null) { yield* Console.error(`design-inventory: ${loaded.reason ?? "policy is unavailable"} (${loaded.source})`); return yield* Effect.sync(() => process.exit(2)); }
	if (!loaded.policy.enabled) { yield* Console.log(`design-inventory: disabled by repository policy (${loaded.source})`); return; }
	const policy = loaded.policy; if (policy.artifactPath === null || policy.tags === null) { yield* Console.error("design-inventory: enabled policy is incomplete"); return yield* Effect.sync(() => process.exit(2)); }
	const patterns = policy.sourceGlobs.map(globPattern); const paths = walk(resolvedRoot).filter((path) => patterns.some((pattern) => pattern.test(path))).sort(); const files: SourceFile[] = [];
	for (const path of paths) { try { files.push({path, content: readFileSync(join(resolvedRoot, path), "utf8")}); } catch { yield* Console.error(`design-inventory: configured source could not be read: ${path}`); return yield* Effect.sync(() => process.exit(2)); } }
	const inventory = buildInventory(files, policy.tags); if (!inventory.pass) { yield* Console.error("design-inventory: configured source scope produced ZERO annotated entries — enabled policy is fail-closed"); return yield* Effect.sync(() => process.exit(1)); }
	const rendered = renderInventory(inventory.entries, policy.artifactPath);
	if (mode === "check") { let existing: string | null; try { existing = readFileSync(join(resolvedRoot, policy.artifactPath), "utf8"); } catch { existing = null; } if (existing !== rendered) { yield* Console.error(`design-inventory: ${policy.artifactPath} is missing or stale — run pipeline-cli design-inventory generate and commit the descriptive artifact`); return yield* Effect.sync(() => process.exit(1)); } yield* Console.log(`design-inventory: ${policy.artifactPath} is fresh (${inventory.entries.length} entries)`); return; }
	if (stdout) { yield* Console.log(rendered); return; }
	try { writeFileSync(join(resolvedRoot, policy.artifactPath), rendered, "utf8"); } catch { yield* Console.error(`design-inventory: configured artifact could not be written: ${policy.artifactPath}`); return yield* Effect.sync(() => process.exit(2)); }
	yield* Console.log(`design-inventory: wrote ${policy.artifactPath} (${inventory.entries.length} entries)`);
});
const generate = Command.make("generate", {root: rootFlag, stdout: stdoutFlag}, ({root, stdout}) => execute("generate", root, stdout)()).pipe(Command.withDescription("Generate only the repository-configured descriptive inventory artifact"));
const check = Command.make("check", {root: rootFlag}, ({root}) => execute("check", root, false)()).pipe(Command.withDescription("Read-only CI check for drift in the configured descriptive inventory artifact"));
export const designInventoryCommand = Command.make("design-inventory").pipe(Command.withSubcommands([generate, check]), Command.withDescription("Optional, policy-owned descriptive design inventory; disabled unless explicitly configured"));
