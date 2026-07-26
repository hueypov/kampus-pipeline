#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ARCHIVED_SKILL_NAMES, CORE_AGENT_NAMES, CORE_AGENT_SKILL_NAMES, CORE_SKILL_DEPENDENCIES, CORE_SKILL_NAMES, CORE_WORKFLOW_SUPPORT_FILES, renderWorkflowCatalog} from "./payload.ts";

const TOOLKIT_RELATIVE_PATH = ".pipeline/toolkit";
const CONFIG_RELATIVE_PATH = ".pipeline/pipeline.json";
const PACKAGE_JSON_RELATIVE_PATH = "package.json";
const PIPELINE_PACKAGE_SCRIPT = "./.pipeline/toolkit/bin/pipeline";
const SETTINGS_RELATIVE_PATH = ".claude/settings.json";
const LANGUAGE_TEMPLATE_RELATIVE_PATH = "templates/glossary/LANGUAGE.md";
const LANGUAGE_RELATIVE_PATH = ".glossary/LANGUAGE.md";
const TERMS_TEMPLATE_RELATIVE_PATH = "templates/glossary/TERMS.md";
const TERMS_RELATIVE_PATH = ".glossary/TERMS.md";
const CREW_CONFIG_TEMPLATE_RELATIVE_PATH = "claude-plugins/pipeline-crew/crew.config.template.jsonc";
const CREW_CONFIG_RELATIVE_PATH = ".claude/crew.config.jsonc";
const CREW_CONFIG_GITIGNORE_ENTRY = ".claude/crew.config.jsonc";
const DOCUMENT_TOPOLOGY_TEMPLATES = [
	{source: "templates/docs/CLAUDE.md", destination: "CLAUDE.md"},
	{source: "templates/decisions/README.md", destination: ".decisions/README.md"},
	{source: "templates/patterns/index.md", destination: ".patterns/index.md"},
	{source: "templates/pipeline/agent-policy.json", destination: ".pipeline/agent-policy.json"},
	{source: "templates/pipeline/optional-workflow-policy.json", destination: ".pipeline/optional-workflow-policy.json"},
	{source: "templates/pipeline/cli-capability-matrix.md", destination: ".pipeline/cli-capability-matrix.md"},
] as const;
const WORKFLOW_CATALOG_RELATIVE_PATH = "claude-plugins/kampus-pipeline/workflow-catalog.json";
const WORKFLOW_CATALOG_CONSUMER_PATH = ".pipeline/workflow-catalog.json";
const LEGACY_PLUGIN_LINK_RELATIVE_PATH = "claude-plugins/kampus-pipeline";
const GITHUB_WORKFLOW_TEMPLATES = [
	{source: "templates/github/workflows/pipeline-toolkit.yml", destination: ".github/workflows/pipeline-toolkit.yml"},
	{source: "templates/github/workflows/pipeline-doc-safety.yml", destination: ".github/workflows/pipeline-doc-safety.yml"},
	{source: "templates/github/workflows/pipeline-delivery-gate.yml", destination: ".github/workflows/pipeline-delivery-gate.yml"},
] as const;
type ManagedPath = {path: string; target: string};
type PipelineConfig = {
	schemaVersion: 3 | 4;
	toolkitRoot: string;
	managedPaths: ManagedPath[];
	managedHooks: Record<string, unknown[]>;
};
type OptionalWorkflowSetting = {enabled?: boolean; [key: string]: unknown};
type OptionalWorkflowPolicy = {
	schemaVersion: 1;
	workflows: Record<string, OptionalWorkflowSetting>;
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
	if (!existsSync(join(toolkit, WORKFLOW_CATALOG_RELATIVE_PATH))) fail(`toolkit is missing ${WORKFLOW_CATALOG_RELATIVE_PATH}`);
	if (!existsSync(join(toolkit, LANGUAGE_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${LANGUAGE_TEMPLATE_RELATIVE_PATH}`);
	if (!existsSync(join(toolkit, TERMS_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${TERMS_TEMPLATE_RELATIVE_PATH}`);
	if (!existsSync(join(toolkit, CREW_CONFIG_TEMPLATE_RELATIVE_PATH))) fail(`toolkit is missing ${CREW_CONFIG_TEMPLATE_RELATIVE_PATH}`);
	for (const template of DOCUMENT_TOPOLOGY_TEMPLATES) {
		if (!existsSync(join(toolkit, template.source))) fail(`toolkit is missing ${template.source}`);
	}
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

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const parseOptionalWorkflowPolicy = (value: unknown): OptionalWorkflowPolicy | undefined => {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.workflows)) return undefined;
	for (const setting of Object.values(value.workflows)) if (!isRecord(setting)) return undefined;
	return value as OptionalWorkflowPolicy;
};

const isStringArray = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string");

const parseAgentPolicy = (value: unknown): Record<string, unknown> | undefined => {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.github)) return undefined;
	if (value.git !== undefined) {
		if (!isRecord(value.git)) return undefined;
		if (value.git.primaryBranch !== undefined && value.git.primaryBranch !== null && (typeof value.git.primaryBranch !== "string" || !value.git.primaryBranch.trim())) return undefined;
		if (value.git.postSyncCommand !== undefined && value.git.postSyncCommand !== null && (!isStringArray(value.git.postSyncCommand) || value.git.postSyncCommand.length === 0 || value.git.postSyncCommand.some((part) => !part.trim()))) return undefined;
	}
	if (value.worktrees !== undefined) {
		if (!isRecord(value.worktrees)) return undefined;
		if (value.worktrees.managedRoots !== undefined && !isStringArray(value.worktrees.managedRoots)) return undefined;
		if (value.worktrees.reviewPrefixes !== undefined && !isStringArray(value.worktrees.reviewPrefixes)) return undefined;
		if (value.worktrees.idleMinutes !== undefined && (!Number.isInteger(value.worktrees.idleMinutes) || (value.worktrees.idleMinutes as number) < 0)) return undefined;
	}
	const review = (value.github as Record<string, unknown>).review;
	if (review !== undefined && !isRecord(review)) return undefined;
	const trivialDiff = isRecord(review) ? review.trivialDiff : undefined;
	if (trivialDiff !== undefined) {
		if (!isRecord(trivialDiff) || typeof trivialDiff.enabled !== "boolean" || !Number.isInteger(trivialDiff.maxChangedLines) || (trivialDiff.maxChangedLines as number) < 0 || !isStringArray(trivialDiff.protectedPaths)) return undefined;
	}
	return value;
};

const readOptionalWorkflowPolicy = (projectRoot: string): OptionalWorkflowPolicy => {
	const path = join(projectRoot, ".pipeline/optional-workflow-policy.json");
	try {
		const policy = parseOptionalWorkflowPolicy(JSON.parse(readFileSync(path, "utf8")) as unknown);
		if (!policy) return fail(".pipeline/optional-workflow-policy.json has an unsupported shape");
		return policy;
	} catch (error) {
		if (error instanceof SyntaxError) fail(".pipeline/optional-workflow-policy.json is not valid JSON");
		throw error;
	}
};

const enabledOptionalWorkflowNames = (policy: OptionalWorkflowPolicy): Set<string> => new Set(
	Object.entries(policy.workflows)
		.filter(([name, setting]) => ARCHIVED_SKILL_NAMES.has(name) && setting.enabled === true)
		.map(([name]) => name),
);

const lstatSyncSafe = (path: string) => {
	try { return lstatSync(path); } catch { return undefined; }
};

const retireLegacyPluginLink = (projectRoot: string, prior: Map<string, string>): void => {
	const expectedTarget = prior.get(LEGACY_PLUGIN_LINK_RELATIVE_PATH);
	const path = join(projectRoot, LEGACY_PLUGIN_LINK_RELATIVE_PATH);
	if (!expectedTarget || !lstatSyncSafe(path)?.isSymbolicLink()) return;
	if (readlinkSync(path) === expectedTarget) rmSync(path, {recursive: true, force: true});
};

const pipelineHooks = (): Record<string, unknown[]> => {
	const hook = (suffix: string, timeout?: number) => ({
		type: "command",
		command: `"$CLAUDE_PROJECT_DIR/.pipeline/toolkit/claude-plugins/kampus-pipeline/hooks/${suffix}"`,
		...(timeout ? {timeout} : {}),
	});
	return {
		SessionStart: [{matcher: "startup|resume", hooks: [hook("install.sh", 120)]}],
		PreToolUse: [
			{matcher: "Read|Edit|Write", hooks: [hook("guard.sh worktree-guard pre-file")]},
			{matcher: "Bash", hooks: [hook("guard.sh worktree-guard pre-bash")]},
			{matcher: "EnterWorktree", hooks: [hook("guard.sh worktree-guard pre-enter")]},
		],
		SubagentStop: [{matcher: "*", hooks: [hook("guard.sh worktree-guard reap")]}],
		WorktreeCreate: [{hooks: [hook("create-worktree.sh", 600)]}],
	};
};

const isPipelineHook = (entry: unknown): boolean => {
	const serialized = JSON.stringify(entry);
	return serialized.includes("claude-plugins/kampus-pipeline/hooks/")
		|| serialized.includes(".pipeline/toolkit/claude-plugins/kampus-pipeline/hooks/");
};

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
	const managedHooks = pipelineHooks();
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

/** Link one generated, read-only toolkit artifact without ever replacing an adopter-owned file. */
const linkManagedFile = (projectRoot: string, toolkitRoot: string, sourceRelative: string, destinationRelative: string, force: boolean, prior: Map<string, string>): ManagedPath => {
	const source = join(toolkitRoot, sourceRelative);
	const destination = join(projectRoot, destinationRelative);
	const target = relative(dirname(destination), source);
	const existing = lstatSyncSafe(destination);
	if (existing) {
		let expected = false;
		try { expected = existing.isSymbolicLink() && readlinkSync(destination) === target; } catch {}
		if (!expected && !(force && prior.get(destinationRelative) === target)) {
			fail(`refusing to replace existing ${destinationRelative}`);
		}
		if (!expected) rmSync(destination, {recursive: true, force: true});
	}
	if (!lstatSyncSafe(destination)) {
		mkdirSync(dirname(destination), {recursive: true});
		symlinkSync(target, destination, "file");
	}
	return {path: destinationRelative, target};
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

const ensureGitignoreEntry = (projectRoot: string, entry: string): void => {
	const path = join(projectRoot, ".gitignore");
	const current = existsSync(path) ? readFileSync(path, "utf8") : "";
	if (current.split(/\r?\n/).some((line) => line.trim() === entry)) return;
	writeFileSync(path, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
};

const hasCrewConfigPlaceholders = (projectRoot: string): boolean => {
	try {
		return /"<[^">\n]+>"/.test(readFileSync(join(projectRoot, CREW_CONFIG_RELATIVE_PATH), "utf8"));
	} catch {
		return false;
	}
};

const installToolkit = (toolkitRoot: string): void => {
	run("pnpm", ["install", "--frozen-lockfile"], toolkitRoot);
	run("pnpm", ["--filter", "@kampus/pipeline-cli", "build"], toolkitRoot);
};

const supportsTypeStripping = (): boolean => {
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	return major > 22 || (major === 22 && minor >= 6);
};

type StatusItem = {name: string; type: string; state: "installed" | "missing-or-drifted" | "disabled" | "enabled-adapter-required"; path?: string};

const safeJson = (path: string): unknown | undefined => {
	try { return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as unknown : undefined; } catch { return undefined; }
};

const expectedLinkTarget = (projectRoot: string, toolkitRoot: string, sourceRelative: string, destinationRelative: string): string =>
	relative(dirname(join(projectRoot, destinationRelative)), join(toolkitRoot, sourceRelative));

const managedLinkState = (projectRoot: string, config: PipelineConfig | undefined, path: string, target: string): "installed" | "missing-or-drifted" => {
	const declared = config?.managedPaths.some((entry) => entry.path === path && entry.target === target) ?? false;
	const destination = join(projectRoot, path);
	let actual = false;
	try { actual = lstatSync(destination).isSymbolicLink() && readlinkSync(destination) === target; } catch {}
	return declared && actual ? "installed" : "missing-or-drifted";
};

/** Shared, local-only status projection. `check` consumes its errors and `status` exposes its detail. */
const resolveStatus = (projectRoot: string): {errors: string[]; policy: "valid" | "missing-or-malformed"; catalogue: "current" | "missing-or-drifted"; core: StatusItem[]; optional: StatusItem[]} => {
	const errors = check(projectRoot);
	const configValue = safeJson(join(projectRoot, CONFIG_RELATIVE_PATH));
	const config = isRecord(configValue) && Array.isArray(configValue.managedPaths)
		? configValue as unknown as PipelineConfig
		: undefined;
	const toolkitRoot = toolkitRootFor(projectRoot);
	const policy = parseAgentPolicy(safeJson(join(projectRoot, ".pipeline/agent-policy.json"))) ? "valid" : "missing-or-malformed";
	const optionalPolicy = parseOptionalWorkflowPolicy(safeJson(join(projectRoot, ".pipeline/optional-workflow-policy.json")));
	const expectedCatalog = expectedLinkTarget(projectRoot, toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH, WORKFLOW_CATALOG_CONSUMER_PATH);
	const catalogue = existsSync(join(toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH)) &&
		readFileSync(join(toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH), "utf8") === renderWorkflowCatalog() &&
		managedLinkState(projectRoot, config, WORKFLOW_CATALOG_CONSUMER_PATH, expectedCatalog) === "installed"
		? "current" : "missing-or-drifted";
	const core: StatusItem[] = [
		...Array.from(CORE_SKILL_NAMES).map((name) => ({name, type: "skill", path: `.claude/skills/${name}`,
			state: managedLinkState(projectRoot, config, `.claude/skills/${name}`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/skills/${name}`, `.claude/skills/${name}`))})),
		...Array.from(CORE_WORKFLOW_SUPPORT_FILES).map((name) => ({name, type: "support-file", path: `.claude/skills/${name}`,
			state: managedLinkState(projectRoot, config, `.claude/skills/${name}`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/skills/${name}`, `.claude/skills/${name}`))})),
		...Array.from(CORE_AGENT_NAMES).map((name) => ({name, type: "agent", path: `.claude/agents/${name}.md`,
			state: managedLinkState(projectRoot, config, `.claude/agents/${name}.md`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/agents/${name}.md`, `.claude/agents/${name}.md`))})),
		...GITHUB_WORKFLOW_TEMPLATES.map((template): StatusItem => ({name: template.destination, type: "generated-workflow", path: template.destination,
			state: config?.managedPaths.some((entry) => entry.path === template.destination && entry.target === `template:${template.source}`) && existsSync(join(projectRoot, template.destination)) ? "installed" : "missing-or-drifted"})),
		...(["main-sync", "trivial-diff classify", "worktree-sweep"] as const).map((name): StatusItem => ({name, type: "cli-command", path: ".pipeline/toolkit/bin/pipeline",
			state: existsSync(join(projectRoot, ".pipeline/toolkit/bin/pipeline")) ? "installed" : "missing-or-drifted"})),
	];
	const optional = Array.from(ARCHIVED_SKILL_NAMES).map((name) => {
		const enabled = optionalPolicy?.workflows[name]?.enabled === true;
		const state = enabled
			? managedLinkState(projectRoot, config, `.claude/skills/${name}`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/skills/${name}`, `.claude/skills/${name}`)) === "installed"
				? "enabled-adapter-required" as const : "missing-or-drifted" as const
			: "disabled" as const;
		return {name, type: "optional-skill", state, path: `.claude/skills/${name}`};
	});
	return {errors, policy, catalogue, core, optional};
};

const check = (projectRoot: string): string[] => {
	const errors: string[] = [];
	let toolkitRoot = "";
	try { toolkitRoot = assertToolkit(projectRoot); } catch { return ["toolkit submodule is not initialized"]; }
	try {
		if (readFileSync(join(toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH), "utf8") !== renderWorkflowCatalog()) {
			errors.push("toolkit workflow catalogue differs from the typed manifest");
		}
	} catch {
		errors.push("missing or invalid toolkit workflow catalogue");
	}
	for (const command of ["node", "pnpm"]) if (!commandExists(command)) errors.push(`missing required command: ${command}`);
	if (!supportsTypeStripping()) errors.push("Node.js 22.6 or newer is required");
	const config = readConfig(projectRoot);
	if (toolkitRoot && config?.toolkitRoot !== TOOLKIT_RELATIVE_PATH) errors.push("pipeline config has an unsupported toolkit path");
	if (!config) {
		errors.push("missing " + CONFIG_RELATIVE_PATH);
		return errors;
	}
	const agentPolicyPath = join(projectRoot, ".pipeline/agent-policy.json");
	try {
		const policy = parseAgentPolicy(JSON.parse(readFileSync(agentPolicyPath, "utf8")) as unknown);
		if (!policy) {
			errors.push("agent policy has an unsupported shape");
		}
	} catch {
		errors.push("missing or invalid .pipeline/agent-policy.json");
	}
	let enabledOptionalWorkflows = new Set<string>();
	const optionalWorkflowPolicyPath = join(projectRoot, ".pipeline/optional-workflow-policy.json");
	try {
		const policy = parseOptionalWorkflowPolicy(JSON.parse(readFileSync(optionalWorkflowPolicyPath, "utf8")) as unknown);
		if (!policy) errors.push("optional-workflow policy has an unsupported shape");
		else enabledOptionalWorkflows = enabledOptionalWorkflowNames(policy);
	} catch {
		errors.push("missing or invalid .pipeline/optional-workflow-policy.json");
	}
	if (!Array.isArray(config.managedPaths) || !config.managedPaths.length) {
		errors.push("pipeline config has no managed paths");
	} else {
		for (const managed of config.managedPaths) {
			if (!managed || typeof managed.path !== "string" || typeof managed.target !== "string") {
				errors.push("pipeline config has an invalid managed path entry");
				continue;
			}
			const path = join(projectRoot, managed.path);
			if (!existsSync(path) && !(lstatSyncSafe(path)?.isSymbolicLink() ?? false)) {
				errors.push(`missing managed path: ${managed.path}`);
				continue;
			}
			if (!managed.target.startsWith("template:")) {
				const actualTarget = lstatSyncSafe(path)?.isSymbolicLink() ? readlinkSync(path) : undefined;
				if (actualTarget !== managed.target) errors.push(`managed link has an unexpected target: ${managed.path}`);
			}
		}
		const managedPaths = new Set(config.managedPaths.map((managed) => managed.path));
		const expectedCatalogTarget = expectedLinkTarget(projectRoot, toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH, WORKFLOW_CATALOG_CONSUMER_PATH);
		if (managedLinkState(projectRoot, config, WORKFLOW_CATALOG_CONSUMER_PATH, expectedCatalogTarget) !== "installed") {
			errors.push(`missing or drifted managed catalogue link: ${WORKFLOW_CATALOG_CONSUMER_PATH} (run pipeline init to repair)`);
		}
		for (const skill of CORE_SKILL_NAMES) {
			if (!managedPaths.has(`.claude/skills/${skill}`)) {
				errors.push(`missing managed core skill: ${skill}`);
			}
		}
		for (const file of CORE_WORKFLOW_SUPPORT_FILES) {
			if (!managedPaths.has(`.claude/skills/${file}`)) errors.push(`missing managed core workflow support file: ${file}`);
		}
		for (const skill of ARCHIVED_SKILL_NAMES) {
			const active = managedPaths.has(`.claude/skills/${skill}`);
			if (active && !enabledOptionalWorkflows.has(skill)) {
				errors.push(`archived workflow is activated without a repository-owned adapter: ${skill}`);
			}
			if (enabledOptionalWorkflows.has(skill) && !active) errors.push(`enabled optional workflow is missing its managed skill link: ${skill}`);
		}
		for (const agent of CORE_AGENT_NAMES) {
			if (!managedPaths.has(`.claude/agents/${agent}.md`)) {
				errors.push(`missing managed core agent: ${agent}`);
			}
		}
		for (const [agent, skills] of Object.entries(CORE_AGENT_SKILL_NAMES)) {
			for (const skill of skills) {
				if (!CORE_SKILL_NAMES.has(skill)) errors.push(`core agent requires a non-core skill: ${agent} -> ${skill}`);
			}
		}
		for (const [skill, dependencies] of Object.entries(CORE_SKILL_DEPENDENCIES)) {
			for (const dependency of dependencies) {
				if (!CORE_SKILL_NAMES.has(dependency)) {
					errors.push(`core skill dependency is not portable: ${skill} -> ${dependency}`);
				}
			}
		}
	}
	const packagePath = join(projectRoot, PACKAGE_JSON_RELATIVE_PATH);
	try {
		const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {scripts?: Record<string, unknown>};
		if (packageJson.scripts?.pipeline !== PIPELINE_PACKAGE_SCRIPT) errors.push("missing managed package.json pipeline script");
	} catch {
		errors.push(`missing or invalid ${PACKAGE_JSON_RELATIVE_PATH}`);
	}
	const settingsPath = join(projectRoot, SETTINGS_RELATIVE_PATH);
	try {
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {hooks?: Record<string, unknown[]>};
		for (const [event, expected] of Object.entries(pipelineHooks())) {
			const actual = settings.hooks?.[event] ?? [];
			for (const entry of expected) if (!actual.some((candidate) => JSON.stringify(candidate) === JSON.stringify(entry))) {
				errors.push(`missing managed hook: ${event}`);
				break;
			}
		}
	} catch {
		errors.push(`missing or invalid ${SETTINGS_RELATIVE_PATH}`);
	}
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
	const priorConfig = readConfig(projectRoot);
	const prior = new Map((priorConfig?.managedPaths ?? []).map((entry) => [entry.path, entry.target]));
	retireLegacyPluginLink(projectRoot, prior);
	const languageVocabulary = materializeTemplate(projectRoot, toolkitRoot, LANGUAGE_TEMPLATE_RELATIVE_PATH, LANGUAGE_RELATIVE_PATH, prior);
	const domainVocabulary = materializeTemplate(projectRoot, toolkitRoot, TERMS_TEMPLATE_RELATIVE_PATH, TERMS_RELATIVE_PATH, prior);
	const crewConfig = materializeTemplate(projectRoot, toolkitRoot, CREW_CONFIG_TEMPLATE_RELATIVE_PATH, CREW_CONFIG_RELATIVE_PATH, prior);
	if (crewConfig) ensureGitignoreEntry(projectRoot, CREW_CONFIG_GITIGNORE_ENTRY);
	const documentTopology = DOCUMENT_TOPOLOGY_TEMPLATES.flatMap((template) => {
		const managed = materializeTemplate(projectRoot, toolkitRoot, template.source, template.destination, prior);
		return managed ? [managed] : [];
	});
	const workflowCatalog = linkManagedFile(projectRoot, toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH, WORKFLOW_CATALOG_CONSUMER_PATH, force, prior);
	const optionalWorkflowPolicy = readOptionalWorkflowPolicy(projectRoot);
	const enabledOptionalWorkflows = enabledOptionalWorkflowNames(optionalWorkflowPolicy);
	const githubWorkflows = GITHUB_WORKFLOW_TEMPLATES.flatMap((template) => {
			const managed = materializeTemplate(projectRoot, toolkitRoot, template.source, template.destination, prior);
			return managed ? [managed] : [];
		});
	const managedHooks = mergeSettings(projectRoot, toolkitRoot);
	mergePackageScript(projectRoot);
	const managedPaths = [
		...(languageVocabulary ? [languageVocabulary] : []),
		...(domainVocabulary ? [domainVocabulary] : []),
		...(crewConfig ? [crewConfig] : []),
		...documentTopology,
		workflowCatalog,
		...githubWorkflows,
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/kampus-pipeline/agents", ".claude/agents", () => true, force, prior),
		...linkEntries(projectRoot, toolkitRoot, "claude-plugins/kampus-pipeline/skills", ".claude/skills", (name) =>
			(CORE_SKILL_NAMES.has(name) && existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name, "SKILL.md"))) ||
			(enabledOptionalWorkflows.has(name) && existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name, "SKILL.md"))) ||
			(CORE_WORKFLOW_SUPPORT_FILES.has(name) && existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name))),
		force, prior),
	];
	writeJson(join(projectRoot, CONFIG_RELATIVE_PATH), {schemaVersion: 4, toolkitRoot: TOOLKIT_RELATIVE_PATH, managedPaths, managedHooks} satisfies PipelineConfig);
	const errors = check(projectRoot);
	if (errors.length) console.error(`pipeline: initialized with required follow-up:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	else console.error("pipeline: initialized and ready");
	if (hasCrewConfigPlaceholders(projectRoot)) {
		console.error(`pipeline: Crew setup required: fill every placeholder in ${CREW_CONFIG_RELATIVE_PATH} before running pipeline crew stand-up`);
	}
};

const enable = (args: string[]): void => {
	const requested = args.includes("--project-root") ? args[args.indexOf("--project-root") + 1] : undefined;
	if (args.includes("--project-root") && !requested) fail("--project-root requires a path");
	const workflow = args.find((arg) => arg !== "--project-root" && arg !== requested)
		?? fail(`workflow name is required; available: ${Array.from(ARCHIVED_SKILL_NAMES).join(", ")}`);
	if (!ARCHIVED_SKILL_NAMES.has(workflow)) fail(`workflow is not optional or does not exist: ${workflow}`);
	const projectRoot = findProjectRoot(requested);
	const policy = readOptionalWorkflowPolicy(projectRoot);
	policy.workflows[workflow] = {...policy.workflows[workflow], enabled: true};
	writeJson(join(projectRoot, ".pipeline/optional-workflow-policy.json"), policy);
	init(["--project-root", projectRoot]);
	const errors = check(projectRoot);
	if (errors.length) fail(`enable failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	console.log(`pipeline: enabled optional workflow ${workflow}; configure its repository-owned adapter before external operations`);
};

const status = (args: string[]): void => {
	const json = args.includes("--json");
	const requested = args.includes("--project-root") ? args[args.indexOf("--project-root") + 1] : undefined;
	if (args.includes("--project-root") && !requested) fail("--project-root requires a path");
	const unknown = args.filter((arg) => arg !== "--json" && arg !== "--project-root" && arg !== requested);
	if (unknown.length) fail(`unknown status argument(s): ${unknown.join(", ")}`);
	const state = resolveStatus(findProjectRoot(requested));
	if (json) {
		console.log(JSON.stringify({ok: state.errors.length === 0, ...state}, null, "\t"));
	} else {
		console.log(`pipeline: ${state.errors.length ? "drift detected" : "installed state is consistent"}`);
		console.log(`catalogue: ${state.catalogue}; policy: ${state.policy}`);
		for (const item of state.core) if (item.state !== "installed") console.log(`- ${item.type} ${item.name}: ${item.state}`);
		for (const item of state.optional) console.log(`- ${item.type} ${item.name}: ${item.state}`);
		for (const error of state.errors) console.log(`- ${error}`);
	}
	if (state.errors.length) process.exitCode = 1;
};

const forward = (packagePath: string, args: string[]): never => {
	const result = spawnSync("node", ["--experimental-strip-types", join(sourceToolkitRoot, packagePath), ...args], {stdio: "inherit"});
	process.exit(result.status ?? 1);
};

const [command, ...args] = process.argv.slice(2);
if (command === "init" || command === "sync") init(args);
else if (command === "enable") enable(args);
else if (command === "status") status(args);
else if (command === "check") {
	const errors = check(findProjectRoot(args[0]));
	if (errors.length) fail(`check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	console.log("pipeline: check passed");
} else if (command === "cli") {
	if (!args[0]) fail("CLI tool is required");
	forward("packages/pipeline-cli/src/bin.ts", args);
}
else if (command === "crew") forward("packages/pipeline-crew-mcp/src/bin.ts", args);
else fail("usage: pipeline <init|sync|check|status|enable|cli|crew> [args]");
