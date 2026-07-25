#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const TOOLKIT_RELATIVE_PATH = ".pipeline/toolkit";
const CONFIG_RELATIVE_PATH = ".pipeline/pipeline.json";
const SETTINGS_RELATIVE_PATH = ".claude/settings.json";
const CREW_CONFIG_RELATIVE_PATH = ".claude/crew.config.jsonc";
const MANAGED_IGNORE_RELATIVE_PATH = ".claude/.gitignore";
const LANGUAGE_TEMPLATE_RELATIVE_PATH = "templates/glossary/LANGUAGE.md";
const LANGUAGE_RELATIVE_PATH = ".glossary/LANGUAGE.md";
type ManagedPath = {path: string; target: string};
type PipelineConfig = {
	schemaVersion: 1;
	toolkitRoot: string;
	managedPaths: ManagedPath[];
};

const here = dirname(fileURLToPath(import.meta.url));
const sourceToolkitRoot = resolve(here, "../../..");

const fail = (message: string): never => {
	console.error(`pipeline: ${message}`);
	process.exit(1);
};

const run = (command: string, args: string[], cwd: string): string => {
	const result = spawnSync(command, args, {cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
	if (result.error || result.status !== 0) fail(result.stderr.trim() || `could not run ${command}`);
	return result.stdout.trim();
};

const findProjectRoot = (requested?: string): string => {
	const cwd = resolve(requested ?? process.cwd());
	return run("git", ["rev-parse", "--show-toplevel"], cwd);
};

const toolkitRootFor = (projectRoot: string): string => resolve(projectRoot, TOOLKIT_RELATIVE_PATH);

const assertToolkit = (projectRoot: string): string => {
	const toolkit = toolkitRootFor(projectRoot);
	if (!existsSync(join(toolkit, "package.json"))) fail(`missing initialized toolkit at ${TOOLKIT_RELATIVE_PATH}`);
	if (!existsSync(join(toolkit, "packages/pipeline-cli/src/bin.ts"))) fail("toolkit is missing packages/pipeline-cli");
	if (!existsSync(join(toolkit, "packages/pipeline-crew-mcp/src/bin.ts"))) fail("toolkit is missing packages/pipeline-crew-mcp");
	if (!existsSync(join(toolkit, LANGUAGE_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${LANGUAGE_TEMPLATE_RELATIVE_PATH}`);
	const submodule = spawnSync("git", ["submodule", "status", "--", TOOLKIT_RELATIVE_PATH], {
		cwd: projectRoot,
		encoding: "utf8",
	});
	if (submodule.status !== 0 || !submodule.stdout.trim() || submodule.stdout.startsWith("-")) {
		fail(`${TOOLKIT_RELATIVE_PATH} must be an initialized Git submodule`);
	}
	return toolkit;
};

const commandExists = (command: string): boolean => {
	const result = spawnSync(command, ["--version"], {stdio: "ignore"});
	return !result.error && result.status === 0;
};

const isGitHubAuthenticated = (): boolean => {
	const result = spawnSync("gh", ["auth", "status"], {stdio: "ignore"});
	return !result.error && result.status === 0;
};

const readConfig = (projectRoot: string): PipelineConfig | undefined => {
	const path = join(projectRoot, CONFIG_RELATIVE_PATH);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as PipelineConfig;
	} catch {
		fail(`${CONFIG_RELATIVE_PATH} is not valid JSON`);
	}
};

const writeJson = (path: string, value: unknown): void => {
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
};

const pipelineHooks = (toolkitRoot: string, projectRoot: string): Record<string, unknown[]> => {
	const hook = (suffix: string, timeout?: number) => ({
		type: "command",
		command: `"$CLAUDE_PROJECT_DIR/${relative(projectRoot, toolkitRoot)}/claude-plugins/kampus-pipeline/hooks/${suffix}"`,
		...(timeout ? {timeout} : {}),
	});
	return {
		SessionStart: [{matcher: "startup|resume", hooks: [hook("install.sh", 120), hook("guard.sh spawn-guard freshness"), hook("guard.sh worktree-sweep --execute")]}],
		PreToolUse: [
			{matcher: "Read|Edit|Write", hooks: [hook("guard.sh worktree-guard pre-file")]},
			{matcher: "Bash", hooks: [hook("guard.sh worktree-guard pre-bash")]},
			{matcher: "EnterWorktree", hooks: [hook("guard.sh worktree-guard pre-enter")]},
			{matcher: "Task|Workflow", hooks: [hook("guard.sh spawn-guard guard")]},
		],
		SubagentStop: [{matcher: "*", hooks: [hook("guard.sh worktree-guard reap")]}],
		WorktreeCreate: [{hooks: [hook("create-worktree.sh", 600)]}],
	};
};

const mergeSettings = (projectRoot: string, toolkitRoot: string): void => {
	const settingsPath = join(projectRoot, SETTINGS_RELATIVE_PATH);
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			fail(`${SETTINGS_RELATIVE_PATH} is not valid JSON; refusing to overwrite it`);
		}
	}
	const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
	for (const [event, additions] of Object.entries(pipelineHooks(toolkitRoot, projectRoot))) {
		const current = hooks[event] ?? [];
		const serialized = new Set(current.map((entry) => JSON.stringify(entry)));
		hooks[event] = [...current, ...additions.filter((entry) => !serialized.has(JSON.stringify(entry)))];
	}
	settings.hooks = hooks;
	writeJson(settingsPath, settings);
};

const linkEntries = (projectRoot: string, toolkitRoot: string, sourceRelative: string, destinationRelative: string, accept: (name: string) => boolean, force: boolean, prior: Map<string, string>): ManagedPath[] => {
	const source = join(toolkitRoot, sourceRelative);
	const destination = join(projectRoot, destinationRelative);
	mkdirSync(destination, {recursive: true});
	return readdirSync(source, {withFileTypes: true})
		.filter((entry) => accept(entry.name))
		.map((entry) => {
			const target = join(source, entry.name);
			const path = join(destination, entry.name);
			const relativePath = relative(projectRoot, path);
			const expectedTarget = relative(dirname(path), target);
			if (existsSync(path) || (() => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } })()) {
				let isExpected = false;
				try { isExpected = lstatSync(path).isSymbolicLink() && readlinkSync(path) === expectedTarget; } catch {}
				if (!isExpected && !(force && prior.get(relativePath) === expectedTarget)) fail(`refusing to replace existing ${relativePath}`);
				if (!isExpected) rmSync(path, {recursive: true, force: true});
			}
			if (!existsSync(path)) symlinkSync(expectedTarget, path, entry.isDirectory() ? "dir" : "file");
			return {path: relativePath, target: expectedTarget};
		});
};

const mergeIgnore = (projectRoot: string): void => {
	const path = join(projectRoot, MANAGED_IGNORE_RELATIVE_PATH);
	const required = ["crew.config.jsonc", "crew-run/"];
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	const lines = new Set(current.split("\n").filter(Boolean));
	for (const line of required) lines.add(line);
	mkdirSync(dirname(path), {recursive: true});
	writeFileSync(path, `${[...lines].join("\n")}\n`);
};

const createLanguageVocabulary = (projectRoot: string, toolkitRoot: string, prior: Map<string, string>): ManagedPath | undefined => {
	const destination = join(projectRoot, LANGUAGE_RELATIVE_PATH);
	const target = `template:${LANGUAGE_TEMPLATE_RELATIVE_PATH}`;
	if (existsSync(destination)) {
		return prior.get(LANGUAGE_RELATIVE_PATH) === target
			? {path: LANGUAGE_RELATIVE_PATH, target}
			: undefined;
	}
	mkdirSync(dirname(destination), {recursive: true});
	writeFileSync(destination, readFileSync(join(toolkitRoot, LANGUAGE_TEMPLATE_RELATIVE_PATH)));
	return {path: LANGUAGE_RELATIVE_PATH, target};
};

const installToolkit = (toolkitRoot: string): void => {
	run("pnpm", ["install", "--frozen-lockfile"], toolkitRoot);
	run("pnpm", ["--filter", "@kampus/pipeline-cli", "build"], toolkitRoot);
	run("pnpm", ["--filter", "@kampus/pipeline-crew-mcp", "typecheck"], toolkitRoot);
};

const check = (projectRoot: string): string[] => {
	const errors: string[] = [];
	let toolkitRoot = "";
	try { toolkitRoot = assertToolkit(projectRoot); } catch { return ["toolkit submodule is not initialized"]; }
	for (const command of ["node", "pnpm", "claude", "gh", "tmux"]) if (!commandExists(command)) errors.push(`missing required command: ${command}`);
	if (Number.parseInt(process.versions.node, 10) < 20) errors.push("Node.js 20 or newer is required");
	if (commandExists("gh") && !isGitHubAuthenticated()) errors.push("GitHub CLI is not authenticated; run gh auth login");
	const config = readConfig(projectRoot);
	if (!config) errors.push(`missing ${CONFIG_RELATIVE_PATH}`);
	if (!existsSync(join(projectRoot, SETTINGS_RELATIVE_PATH))) errors.push(`missing ${SETTINGS_RELATIVE_PATH}`);
	if (!existsSync(join(projectRoot, CREW_CONFIG_RELATIVE_PATH))) errors.push(`missing ${CREW_CONFIG_RELATIVE_PATH}`);
	else if (readFileSync(join(projectRoot, CREW_CONFIG_RELATIVE_PATH), "utf8").includes("<placeholder")) errors.push("crew configuration still contains placeholders");
	if (!existsSync(join(projectRoot, LANGUAGE_RELATIVE_PATH))) errors.push(`missing ${LANGUAGE_RELATIVE_PATH}`);
	if (toolkitRoot && config?.toolkitRoot !== TOOLKIT_RELATIVE_PATH) errors.push("pipeline config has an unsupported toolkit path");
	return errors;
};

const init = (args: string[]): void => {
	const force = args.includes("--force");
	const checkOnly = args.includes("--check");
	const requested = args.includes("--project-root") ? args[args.indexOf("--project-root") + 1] : undefined;
	if (args.includes("--project-root") && !requested) fail("--project-root requires a path");
	const projectRoot = findProjectRoot(requested);
	if (checkOnly) {
		const errors = check(projectRoot);
		if (errors.length) fail(`check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
		console.log("pipeline: check passed");
		return;
	}
	const toolkitRoot = assertToolkit(projectRoot);
	installToolkit(toolkitRoot);
	const prior = new Map((readConfig(projectRoot)?.managedPaths ?? []).map((entry) => [entry.path, entry.target]));
	const languageVocabulary = createLanguageVocabulary(projectRoot, toolkitRoot, prior);
	mergeSettings(projectRoot, toolkitRoot);
	const managedPaths = [
		...(languageVocabulary ? [languageVocabulary] : []),
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/kampus-pipeline/skills", ".claude/skills", (name) => existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name, "SKILL.md")), force, prior),
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/kampus-pipeline/agents", ".claude/agents", (name) => name.endsWith(".md"), force, prior),
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/pipeline-crew/agents", ".claude/agents", (name) => name.endsWith(".md"), force, prior),
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/pipeline-crew/commands", ".claude/commands", (name) => name.endsWith(".md"), force, prior),
	];
	const crewDestination = join(projectRoot, CREW_CONFIG_RELATIVE_PATH);
	if (!existsSync(crewDestination)) {
		mkdirSync(dirname(crewDestination), {recursive: true});
		writeFileSync(crewDestination, readFileSync(join(toolkitRoot, "claude-plugins/pipeline-crew/crew.config.template.jsonc")));
	}
	mergeIgnore(projectRoot);
	writeJson(join(projectRoot, CONFIG_RELATIVE_PATH), {schemaVersion: 1, toolkitRoot: TOOLKIT_RELATIVE_PATH, managedPaths} satisfies PipelineConfig);
	const errors = check(projectRoot);
	if (errors.length) console.error(`pipeline: initialized with required follow-up:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	else console.error("pipeline: initialized and ready");
};

const forward = (packagePath: string, args: string[]): never => {
	const result = spawnSync("node", [join(sourceToolkitRoot, packagePath), ...args], {stdio: "inherit"});
	process.exit(result.status ?? 1);
};

const [command, ...args] = process.argv.slice(2);
if (command === "init" || command === "sync") init(args);
else if (command === "check") {
	const errors = check(findProjectRoot(args[0]));
	if (errors.length) fail(`check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	console.log("pipeline: check passed");
} else if (command === "cli") {
	if (!args[0]) fail("CLI tool is required");
	forward("packages/pipeline-cli/src/bin.ts", args);
}
else if (command === "crew") forward("packages/pipeline-crew-mcp/src/bin.ts", args);
else fail("usage: pipeline <init|sync|check|cli|crew> [args]");
