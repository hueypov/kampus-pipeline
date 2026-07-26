import {execFileSync} from "node:child_process";
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {dirname, join, resolve, sep} from "node:path";
import {Console, Effect, Option} from "effect";
import {Command, Flag} from "effect/unstable/cli";
import {judge, manifestDeps, type PackageManifest, renderReport} from "./catalog-guard.ts";
import {readCatalogPolicy} from "./policy.ts";

const rootFlag = Flag.string("root").pipe(Flag.optional, Flag.withDescription("repository root containing .pipeline/optional-workflow-policy.json (default: current Git root)"));

const repositoryRoot = (cwd = process.cwd()): string | null => {
	try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; }
};

const escape = (value: string): string => value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
/** Match repository-relative package directories using the small, documented `*` / `**` glob subset. */
const directoryPattern = (glob: string): RegExp => {
	if (glob === ".") return /^$/;
	const parts = glob.split("/").map((part) => part === "**" ? ".*" : part === "*" ? "[^/]+" : escape(part));
	return new RegExp(`^${parts.join("/")}$`);
};

const walk = (root: string, directory = ""): string[] => {
	const absolute = join(root, directory);
	let entries: string[];
	try { entries = readdirSync(absolute); } catch { return []; }
	const files: string[] = [];
	for (const entry of entries) {
		if (entry === ".git" || entry === "node_modules") continue;
		const rel = directory ? `${directory}/${entry}` : entry;
		let stat: ReturnType<typeof statSync>;
		try { stat = statSync(join(root, rel)); } catch { continue; }
		if (stat.isDirectory()) files.push(...walk(root, rel));
		else if (entry === "package.json") files.push(rel);
	}
	return files;
};

const scopedManifestPaths = (root: string, globs: ReadonlyArray<string>): ReadonlyArray<string> => {
	const patterns = globs.map(directoryPattern);
	return walk(root)
		.filter((path) => patterns.some((pattern) => pattern.test(dirname(path) === "." ? "" : dirname(path).split(sep).join("/"))))
		.sort();
};

const readManifests = (root: string, paths: ReadonlyArray<string>, fields: ReadonlyArray<string>): {readonly manifests: ReadonlyArray<PackageManifest>; readonly error: string | null} => {
	const manifests: PackageManifest[] = [];
	for (const path of paths) {
		const absolute = join(root, path);
		try {
			const raw = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
			if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {manifests, error: `manifest is not a JSON object: ${path}`};
			manifests.push({path, deps: manifestDeps(raw as Record<string, unknown>, fields)});
		} catch {
			return {manifests, error: `manifest could not be read as JSON: ${path}`};
		}
	}
	return {manifests, error: null};
};

const check = Command.make("check", {root: rootFlag}, Effect.fn(function* ({root}) {
	const requested = Option.getOrUndefined(root);
	const resolvedRoot = requested === undefined ? repositoryRoot() : resolve(requested);
	if (resolvedRoot === null) {
		yield* Console.error("catalog-guard: repository root could not be resolved — enabled policy cannot be evaluated");
		return yield* Effect.sync(() => process.exit(2));
	}
	const loaded = readCatalogPolicy(resolvedRoot);
	if (!loaded.trusted || loaded.policy === null) {
		yield* Console.error(`catalog-guard: ${loaded.reason ?? "policy is unavailable"} (${loaded.source})`);
		return yield* Effect.sync(() => process.exit(2));
	}
	if (!loaded.policy.enabled) {
		yield* Console.log(`catalog-guard: disabled by repository policy (${loaded.source})`);
		return;
	}
	if (loaded.policy.workspaceManifest === null || !existsSync(join(resolvedRoot, loaded.policy.workspaceManifest))) {
		yield* Console.error(`catalog-guard: enabled policy names an unreadable workspace manifest: ${loaded.policy.workspaceManifest ?? "(none)"}`);
		return yield* Effect.sync(() => process.exit(2));
	}
	const paths = scopedManifestPaths(resolvedRoot, loaded.policy.packageGlobs);
	const read = readManifests(resolvedRoot, paths, loaded.policy.dependencyFields);
	if (read.error !== null) {
		yield* Console.error(`catalog-guard: ${read.error}`);
		return yield* Effect.sync(() => process.exit(2));
	}
	const verdict = judge(read.manifests, loaded.policy.rule);
	if (verdict.pass) { yield* Console.log(renderReport(verdict)); return; }
	yield* Console.error(renderReport(verdict));
	return yield* Effect.sync(() => process.exit(1));
})).pipe(Command.withDescription("Check an explicitly enabled pnpm catalog/workspace dependency-declaration policy without changing manifests"));

export const catalogGuardCommand = Command.make("catalog-guard").pipe(
	Command.withSubcommands([check]),
	Command.withDescription("Optional, policy-owned pnpm catalog/workspace declaration guard; disabled unless configured"),
);
