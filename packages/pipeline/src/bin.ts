#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {CORE_SKILL_NAMES} from "./payload.ts";

const TOOLKIT_RELATIVE_PATH = ".pipeline/toolkit";
const CONFIG_RELATIVE_PATH = ".pipeline/pipeline.json";
const PACKAGE_JSON_RELATIVE_PATH = "package.json";
const PIPELINE_PACKAGE_SCRIPT = "./.pipeline/toolkit/bin/pipeline";
const SETTINGS_RELATIVE_PATH = ".claude/settings.json";
const LANGUAGE_TEMPLATE_RELATIVE_PATH = "templates/glossary/LANGUAGE.md";
const LANGUAGE_RELATIVE_PATH = ".glossary/LANGUAGE.md";
const TERMS_TEMPLATE_RELATIVE_PATH = "templates/glossary/TERMS.md";
const TERMS_RELATIVE_PATH = ".glossary/TERMS.md";
const GITHUB_WORKFLOW_TEMPLATES = [
	{source: "templates/github/workflows/pipeline-toolkit.yml", destination: ".github/workflows/pipeline-toolkit.yml"},
	{source: "templates/github/workflows/pipeline-doc-safety.yml", destination: ".github/workflows/pipeline-doc-safety.yml"},
] as const;
type ManagedPath = {path: string; target: string};
type PipelineConfig = {
	schemaVersion: 2;
	toolkitRoot: string;
	managedPaths: ManagedPath[];
	managedHooks: Record<string, unknown[]>;
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
	if (!existsSync(join(toolkit, "claude-plugins/kampus-pipeline"))) fail("toolkit is missing claude-plugins/kampus-pipeline");
	if (!existsSync(join(toolkit, LANGUAGE_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${LANGUAGE_TEMPLATE_RELATIVE_PATH}`);
	if (!existsSync(join(toolkit, TERMS_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${TERMS_TEMPLATE_RELATIVE_PATH}`);
	for (const template of GITHUB_WORKFLOW_TEMPLATES) {
		if (!existsSync(join(toolkit, template.source))) fail(`toolkit is missing ${template.source}`);
	}
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
		SessionStart: [{matcher: "startup|resume", hooks: [hook("install.sh", 120), hook("guard.sh spawn-guard freshness")]}],
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

const isPipelineHook = (entry: unknown): boolean => JSON.stringify(entry).includes("claude-plugins/kampus-pipeline/hooks/");

const mergeSettings = (projectRoot: string, toolkitRoot: string): Record<string, unknown[]> => {
	const settingsPath = join(projectRoot, SETTINGS_RELATIVE_PATH);
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
		} catch {
			fail(`${SETTINGS_RELATIVE_PATH} is not valid JSON; refusing to overwrite it`);
		}
	}
	const hooks = {...((settings.hooks ?? {}) as Record<string, unknown[]>)};
	const managedHooks = pipelineHooks(toolkitRoot, projectRoot);
	for (const event of Object.keys(hooks)) {
		const preserved = (hooks[event] ?? []).filter((entry) => !isPipelineHook(entry));
		if (managedHooks[event]) hooks[event] = preserved;
		else if (preserved.length) hooks[event] = preserved;
		else delete hooks[event];
	}
	for (const [event, additions] of Object.entries(managedHooks)) {
		hooks[event] = [...(hooks[event] ?? []), ...additions];
	}
	settings.hooks = hooks;
	writeJson(settingsPath, settings);
	return managedHooks;
};

const mergePackageScript = (projectRoot: string): void => {
	const packagePath = join(projectRoot, PACKAGE_JSON_RELATIVE_PATH);
	let packageJson: Record<string, unknown> = {private: true};
	if (existsSync(packagePath)) {
		try {
			const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				fail(`${PACKAGE_JSON_RELATIVE_PATH} must contain a JSON object; refusing to overwrite it`);
			}
			packageJson = parsed as Record<string, unknown>;
		} catch {
			fail(`${PACKAGE_JSON_RELATIVE_PATH} is not valid JSON; refusing to overwrite it`);
		}
	}
	const scripts = packageJson.scripts;
	if (scripts !== undefined && (!scripts || typeof scripts !== "object" || Array.isArray(scripts))) {
		fail(`${PACKAGE_JSON_RELATIVE_PATH} has a non-object scripts field; refusing to overwrite it`);
	}
	const nextScripts = {...(scripts as Record<string, unknown> | undefined)};
	if (nextScripts.pipeline !== undefined && nextScripts.pipeline !== PIPELINE_PACKAGE_SCRIPT) {
		fail(`${PACKAGE_JSON_RELATIVE_PATH} already has a pipeline script; refusing to replace it`);
	}
	nextScripts.pipeline = PIPELINE_PACKAGE_SCRIPT;
	packageJson.scripts = nextScripts;
	writeJson(packagePath, packageJson);
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

const materializeTemplate = (projectRoot: string, toolkitRoot: string, sourceRelative: string, destinationRelative: string, prior: Map<string, string>): ManagedPath | undefined => {
	const destination = join(projectRoot, destinationRelative);
	const target = `template:${sourceRelative}`;
	if (existsSync(destination)) {
		return prior.get(destinationRelative) === target
			? {path: destinationRelative, target}
			: undefined;
	}
	mkdirSync(dirname(destination), {recursive: true});
	writeFileSync(destination, readFileSync(join(toolkitRoot, sourceRelative)));
	return {path: destinationRelative, target};
};

const installToolkit = (toolkitRoot: string): void => {
	run("pnpm", ["install", "--frozen-lockfile"], toolkitRoot);
	run("pnpm", ["--filter", "@kampus/pipeline-cli", "build"], toolkitRoot);
};

const supportsTypeStripping = (): boolean => {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 6);
};

const check = (projectRoot: string): string[] => {
	const errors: string[] = [];
	let toolkitRoot = "";
	try { toolkitRoot = assertToolkit(projectRoot); } catch { return ["toolkit submodule is not initialized"]; }
	for (const command of ["node", "pnpm"]) if (!commandExists(command)) errors.push(`missing required command: ${command}`);
	if (!supportsTypeStripping()) errors.push("Node.js 22.6 or newer is required");
	const config = readConfig(projectRoot);
	if (!config) errors.push(`missing ${CONFIG_RELATIVE_PATH}`);
	if (!existsSync(join(projectRoot, SETTINGS_RELATIVE_PATH))) errors.push(`missing ${SETTINGS_RELATIVE_PATH}`);
	if (!existsSync(join(projectRoot, LANGUAGE_RELATIVE_PATH))) errors.push(`missing ${LANGUAGE_RELATIVE_PATH}`);
	if (!existsSync(join(projectRoot, TERMS_RELATIVE_PATH))) errors.push(`missing ${TERMS_RELATIVE_PATH}`);
	if (toolkitRoot && config?.toolkitRoot !== TOOLKIT_RELATIVE_PATH) errors.push("pipeline config has an unsupported toolkit path");
	return errors;
};

const init = (args: string[]): void => {
	const force = args.includes("--force");
	const checkOnly = args.includes("--check");
	const withGitHubActions = args.includes("--with-github-actions");
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
	const priorConfig = readConfig(projectRoot);
	const prior = new Map((priorConfig?.managedPaths ?? []).map((entry) => [entry.path, entry.target]));
	const languageVocabulary = materializeTemplate(projectRoot, toolkitRoot, LANGUAGE_TEMPLATE_RELATIVE_PATH, LANGUAGE_RELATIVE_PATH, prior);
	const domainVocabulary = materializeTemplate(projectRoot, toolkitRoot, TERMS_TEMPLATE_RELATIVE_PATH, TERMS_RELATIVE_PATH, prior);
	const githubWorkflows = GITHUB_WORKFLOW_TEMPLATES
		.filter((template) => withGitHubActions || prior.get(template.destination) === `template:${template.source}`)
		.flatMap((template) => {
			const managed = materializeTemplate(projectRoot, toolkitRoot, template.source, template.destination, prior);
			return managed ? [managed] : [];
		});
	const managedHooks = mergeSettings(projectRoot, toolkitRoot);
	mergePackageScript(projectRoot);
	const managedPaths = [
		...(languageVocabulary ? [languageVocabulary] : []),
		...(domainVocabulary ? [domainVocabulary] : []),
		...githubWorkflows,
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/kampus-pipeline/skills", ".claude/skills", (name) => CORE_SKILL_NAMES.has(name) && existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name, "SKILL.md")), force, prior),
	];
	writeJson(join(projectRoot, CONFIG_RELATIVE_PATH), {schemaVersion: 2, toolkitRoot: TOOLKIT_RELATIVE_PATH, managedPaths, managedHooks} satisfies PipelineConfig);
	const errors = check(projectRoot);
	if (errors.length) console.error(`pipeline: initialized with required follow-up:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	else console.error("pipeline: initialized and ready");
};

const forward = (packagePath: string, args: string[]): never => {
	const result = spawnSync("node", ["--experimental-strip-types", join(sourceToolkitRoot, packagePath), ...args], {stdio: "inherit"});
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
