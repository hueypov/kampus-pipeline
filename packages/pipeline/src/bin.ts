#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {CORE_AGENT_NAMES, CORE_AGENT_SKILL_NAMES, CORE_SKILL_DEPENDENCIES, CORE_SKILL_NAMES, CORE_WORKFLOW_SUPPORT_FILES, renderWorkflowCatalog} from "./payload.ts";

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
const PRIMARY_INDEX_GUARD_HOOK_MARKER = "# kampus-pipeline primary-index-guard managed hook";
const PRIMARY_INDEX_GUARD_HOOK_NAME = "pre-commit";
/**
 * The CI workflows an adopting repository MAY install, each opt-in through
 * `.pipeline/optional-workflow-policy.json`.
 *
 * None is installed by default. Writing seven workflows into somebody's repository means their
 * first pull request is gated on checks about the toolkit rather than about their change — five of
 * these failed out of the box, and `ship-it` then correctly refused to merge anything (#32). An
 * adopter brings their own CI; the pipeline adds guards only where they ask for them.
 *
 * `pipeline-verify` is the one that completes the pipeline: without a check reporting on a head,
 * `ship-it` refuses every merge with PRECONDITION_UNKNOWN, so an adopter who enables nothing else
 * still enables this. It runs a repository-owned `.pipeline/verify.sh` rather than guessing a
 * stack — a guess that is wrong reports green while verifying the wrong thing.
 */
const GITHUB_WORKFLOW_TEMPLATES = [
	{source: "templates/github/workflows/pipeline-verify.yml", destination: ".github/workflows/pipeline-verify.yml"},
	{source: "templates/github/workflows/pipeline-doc-safety.yml", destination: ".github/workflows/pipeline-doc-safety.yml"},
	{source: "templates/github/workflows/pipeline-delivery-gate.yml", destination: ".github/workflows/pipeline-delivery-gate.yml"},
	{source: "templates/github/workflows/pipeline-gitleaks.yml", destination: ".github/workflows/pipeline-gitleaks.yml"},
	{source: "templates/github/workflows/pipeline-doc-links.yml", destination: ".github/workflows/pipeline-doc-links.yml"},
	{source: "templates/github/workflows/pipeline-settings-env-guard.yml", destination: ".github/workflows/pipeline-settings-env-guard.yml"},
	{source: "templates/github/workflows/pipeline-unresolved-threads.yml", destination: ".github/workflows/pipeline-unresolved-threads.yml"},
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

/**
 * Whether `.pipeline/toolkit` is the repository itself rather than a pinned copy. In the toolkit
 * repository, the path is a symlink back to its own root, so the live working tree serves as its
 * own toolkit — the one layout where a submodule cannot exist, because a repository cannot be its
 * own submodule. Both sides are realpathed: `git rev-parse` reports physical paths while the
 * toolkit path is a lexical join, and on macOS even the temp directory is itself a symlink.
 */
const isSelfHostedToolkit = (projectRoot: string): boolean => {
	const toolkit = toolkitRootFor(projectRoot);
	if (!existsSync(toolkit) || realpathSync(toolkit) !== realpathSync(projectRoot)) return false;
	// The committed symlink ships inside every consumer's pinned checkout, where it points at that
	// checkout's own root — the same realpath shape. Only a repository that is nobody's submodule
	// is the toolkit hosting itself; `init` run from inside an adopter's pin must keep hard-failing
	// rather than writing the payload into the pinned tree.
	const superproject = spawnSync("git", ["rev-parse", "--show-superproject-working-tree"], {cwd: projectRoot, encoding: "utf8"});
	return superproject.status === 0 && superproject.stdout.trim() === "";
};

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
	// Self-hosting: every structural check above resolved through the symlink to the live tree, and
	// only the pinning probe below cannot hold. The LEXICAL path is returned on purpose — managed
	// link targets and `check`'s expectations are computed from it, and a realpath here would drift
	// every one of them.
	if (isSelfHostedToolkit(projectRoot)) return toolkit;
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

const isStringRecord = (value: unknown): value is Record<string, string> =>
	isRecord(value) && Object.values(value).every((entry) => typeof entry === "string" && entry.trim() !== "");

const isNormalizedRepositoryPrefix = (value: string): boolean =>
	value !== "" &&
	value === value.trim() &&
	!value.startsWith("/") &&
	!value.includes("\\") &&
	value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const hasCaptureGroups = (pattern: string, minimum: number): boolean =>
	(pattern.match(/(^|[^\\])\((?!\?)/g) ?? []).length >= minimum;

const isRegexWithCaptures = (value: unknown, captures: number): value is string => {
	if (typeof value !== "string" || !value.trim() || !hasCaptureGroups(value, captures)) return false;
	try { new RegExp(value); return true; } catch { return false; }
};

const featureReachabilityPolicy = (policy: Record<string, unknown>): boolean => {
	const adapters = policy.optionalAdapters;
	if (adapters === undefined) return true;
	if (!isRecord(adapters)) return false;
	const reachability = adapters.featureReachability;
	if (reachability === undefined) return true;
	if (!isRecord(reachability) || typeof reachability.enabled !== "boolean") return false;
	const disabledFields = ["definitionsPath", "consumerFilePattern", "journeyFilePattern", "definitionPattern", "journeyPattern", "exemptionPattern"] as const;
	if (!reachability.enabled) {
		return disabledFields.every((field) => reachability[field] === null) &&
			Array.isArray(reachability.consumerRoots) && reachability.consumerRoots.length === 0 &&
			Array.isArray(reachability.journeyRoots) && reachability.journeyRoots.length === 0;
	}
	return isNormalizedRepositoryPrefix(reachability.definitionsPath as string) &&
		isStringArray(reachability.consumerRoots) && reachability.consumerRoots.length > 0 && reachability.consumerRoots.every(isNormalizedRepositoryPrefix) &&
		isRegexWithCaptures(reachability.consumerFilePattern, 0) &&
		isStringArray(reachability.journeyRoots) && reachability.journeyRoots.length > 0 && reachability.journeyRoots.every(isNormalizedRepositoryPrefix) &&
		isRegexWithCaptures(reachability.journeyFilePattern, 0) &&
		isRegexWithCaptures(reachability.definitionPattern, 2) &&
		isRegexWithCaptures(reachability.journeyPattern, 1) &&
		isRegexWithCaptures(reachability.exemptionPattern, 1);
};

type PrimaryIndexGuardPolicy = {
	enabled: boolean;
	protectedPathPrefixes: string[];
	blockThreshold: number;
	attribution: {enabled: boolean; threshold: number; logPath: string | null};
};

const primaryIndexGuardPolicy = (policy: Record<string, unknown>): PrimaryIndexGuardPolicy | undefined => {
	const git = policy.git;
	if (!isRecord(git) || git.primaryIndexGuard === undefined) return undefined;
	const guard = git.primaryIndexGuard;
	if (!isRecord(guard) || typeof guard.enabled !== "boolean" || !isStringArray(guard.protectedPathPrefixes) ||
		guard.protectedPathPrefixes.some((prefix) => !isNormalizedRepositoryPrefix(prefix)) ||
		!Number.isInteger(guard.blockThreshold) || (guard.blockThreshold as number) <= 0) return undefined;
	if (guard.enabled && guard.protectedPathPrefixes.length === 0) return undefined;
	if (!isRecord(guard.attribution) || typeof guard.attribution.enabled !== "boolean" ||
		!Number.isInteger(guard.attribution.threshold) || (guard.attribution.threshold as number) <= 0 ||
		(guard.attribution.logPath !== null && (typeof guard.attribution.logPath !== "string" || !guard.attribution.logPath.trim())) ||
		(guard.attribution.enabled && (guard.attribution.threshold as number) > (guard.blockThreshold as number))) return undefined;
	return guard as unknown as PrimaryIndexGuardPolicy;
};

const parseAgentPolicy = (value: unknown): Record<string, unknown> | undefined => {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.github)) return undefined;
	if (value.git !== undefined) {
		if (!isRecord(value.git)) return undefined;
		if (value.git.primaryBranch !== undefined && value.git.primaryBranch !== null && (typeof value.git.primaryBranch !== "string" || !value.git.primaryBranch.trim())) return undefined;
		if (value.git.primaryRemote !== undefined && value.git.primaryRemote !== null && (typeof value.git.primaryRemote !== "string" || !value.git.primaryRemote.trim())) return undefined;
		if (value.git.postSyncCommand !== undefined && value.git.postSyncCommand !== null && (!isStringArray(value.git.postSyncCommand) || value.git.postSyncCommand.length === 0 || value.git.postSyncCommand.some((part) => !part.trim()))) return undefined;
		if (value.git.primaryIndexGuard !== undefined && !primaryIndexGuardPolicy(value)) return undefined;
	}
	if (value.worktrees !== undefined) {
		if (!isRecord(value.worktrees)) return undefined;
		if (value.worktrees.managedRoots !== undefined && !isStringArray(value.worktrees.managedRoots)) return undefined;
		if (value.worktrees.reviewPrefixes !== undefined && !isStringArray(value.worktrees.reviewPrefixes)) return undefined;
		if (value.worktrees.idleMinutes !== undefined && (!Number.isInteger(value.worktrees.idleMinutes) || (value.worktrees.idleMinutes as number) < 0)) return undefined;
	}
	if (!featureReachabilityPolicy(value)) return undefined;
	const review = (value.github as Record<string, unknown>).review;
	if (review !== undefined && !isRecord(review)) return undefined;
	const classification = isRecord(review) ? review.classification : undefined;
	if (classification !== undefined) {
		if (!isRecord(classification)) return undefined;
		for (const [name, allowEmptyIncludes] of [["code", false], ["docs", false], ["skills", false], ["design", true]] as const) {
			const rules = classification[name];
			if (!isRecord(rules) || !isStringArray(rules.includePatterns) || (!allowEmptyIncludes && rules.includePatterns.length === 0) || rules.includePatterns.some((pattern) => !pattern.trim()) || !isStringArray(rules.excludePatterns) || rules.excludePatterns.some((pattern) => !pattern.trim())) return undefined;
		}
	}
	const trivialDiff = isRecord(review) ? review.trivialDiff : undefined;
	if (trivialDiff !== undefined) {
		if (!isRecord(trivialDiff) || typeof trivialDiff.enabled !== "boolean" || !Number.isInteger(trivialDiff.maxChangedLines) || (trivialDiff.maxChangedLines as number) < 0 || !isStringArray(trivialDiff.protectedPaths)) return undefined;
	}
	const compatibility = (value.github as Record<string, unknown>).cliCompatibility;
	if (compatibility !== undefined) {
		if (!isRecord(compatibility) || typeof compatibility.enabled !== "boolean" || !isRecord(compatibility.pathShim) || typeof compatibility.pathShim.enabled !== "boolean" || !isRecord(compatibility.graphql) || (compatibility.graphql.mode !== "passthrough" && compatibility.graphql.mode !== "rest-only") || !isStringArray(compatibility.graphql.blockVerbs) || !isStringArray(compatibility.graphql.unsupportedJsonFields) || typeof compatibility.graphql.rewriteIssueAndPrEdit !== "boolean" || !isRecord(compatibility.skillLint) || typeof compatibility.skillLint.strictYamlFrontmatter !== "boolean" || typeof compatibility.skillLint.forbidConfiguredGraphqlPaths !== "boolean" || !isStringArray(compatibility.skillLint.selfExemptPaths)) return undefined;
		for (const key of ["targetRepository", "realGhPath"] as const) {
			const configured = compatibility[key];
			if (configured !== null && configured !== undefined && (typeof configured !== "string" || !configured.trim())) return undefined;
		}
	}
	const shipping = (value.github as Record<string, unknown>).shipping;
	if (shipping !== undefined) {
		if (!isRecord(shipping)) return undefined;
		if (shipping.enabled !== undefined && typeof shipping.enabled !== "boolean") return undefined;
		if (shipping.controlPlanePaths !== undefined && !isStringArray(shipping.controlPlanePaths)) return undefined;
		if (shipping.requiredApprovals !== undefined && (!Number.isInteger(shipping.requiredApprovals) || (shipping.requiredApprovals as number) < 0)) return undefined;
		const shipDigest = shipping.shipDigest;
		if (shipDigest !== undefined) {
			if (!isRecord(shipDigest) || !isRecord(shipDigest.categories) || !isRecord(shipDigest.types) || !isRecord(shipDigest.releaseState)) return undefined;
			for (const group of [shipDigest.categories, shipDigest.types]) {
				if (!isStringArray(group.order) || group.order.some((entry) => !entry.trim()) || !isStringRecord(group.labels) || typeof group.fallbackLabel !== "string" || !group.fallbackLabel.trim()) return undefined;
			}
			const releaseState = shipDigest.releaseState;
			if (releaseState.adapter !== null && releaseState.adapter !== undefined && (typeof releaseState.adapter !== "string" || !releaseState.adapter.trim())) return undefined;
			if (releaseState.mergedWithoutReleaseEvidence !== "unknown" && releaseState.mergedWithoutReleaseEvidence !== "live") return undefined;
		}
		const guardContent = shipping.guardContent;
		if (guardContent !== undefined) {
			if (!isRecord(guardContent) || typeof guardContent.enabled !== "boolean" || !isStringArray(guardContent.decisionRecordPaths) || !isStringArray(guardContent.vocabularyPatterns)) return undefined;
			const paths = guardContent.decisionRecordPaths;
			const vocabulary = guardContent.vocabularyPatterns;
			if (paths.some((pattern) => !pattern.trim()) || vocabulary.some((pattern) => !pattern.trim())) return undefined;
			try {
				for (const pattern of [...paths, ...vocabulary]) new RegExp(pattern);
			} catch {
				return undefined;
			}
			if (guardContent.enabled && (paths.length === 0 || vocabulary.length === 0)) return undefined;
			if (!guardContent.enabled && (paths.length !== 0 || vocabulary.length !== 0)) return undefined;
		}
		const protectedChangeApproval = shipping.protectedChangeApproval;
		if (protectedChangeApproval !== undefined) {
			if (!isRecord(protectedChangeApproval) || !isRecord(protectedChangeApproval.authority) || !Number.isInteger(protectedChangeApproval.requiredNonAuthorApprovals) || (protectedChangeApproval.requiredNonAuthorApprovals as number) < 1 || !isRecord(protectedChangeApproval.soleAuthorException) || typeof protectedChangeApproval.soleAuthorException.enabled !== "boolean") return undefined;
			const authority = protectedChangeApproval.authority;
			const soleAuthorException = protectedChangeApproval.soleAuthorException;
			if (typeof authority.provider !== "string" || !authority.provider.trim() || (authority.organization !== null && (typeof authority.organization !== "string" || !authority.organization.trim())) || (authority.teamSlug !== null && (typeof authority.teamSlug !== "string" || !authority.teamSlug.trim())) || (soleAuthorException.commentPattern !== null && (typeof soleAuthorException.commentPattern !== "string" || !soleAuthorException.commentPattern.trim()))) return undefined;
			if (soleAuthorException.enabled) {
				if (soleAuthorException.commentPattern === null) return undefined;
				try { new RegExp(soleAuthorException.commentPattern); } catch { return undefined; }
			} else if (soleAuthorException.commentPattern !== null) return undefined;
		}
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

/**
 * The CI workflows the repository has opted into — now the only optional thing in the payload.
 *
 * There used to be a second resolver for optional *skills*, filtering the same policy block against
 * a set of product-skill names. Reaching for it to gate workflows produced a flag that could never
 * be turned on, because a workflow name was never in that set. Those skills are gone (#34) and so
 * is the second resolver: one optional concept, one predicate, nothing to reach for by mistake.
 */
const enabledWorkflowFileNames = (policy: OptionalWorkflowPolicy): Set<string> => {
	const installable = new Set(GITHUB_WORKFLOW_TEMPLATES.map((t) => basename(t.destination, ".yml")));
	return new Set(
		Object.entries(policy.workflows)
			.filter(([name, setting]) => installable.has(name) && setting.enabled === true)
			.map(([name]) => name),
	);
};

const lstatSyncSafe = (path: string) => {
	try { return lstatSync(path); } catch { return undefined; }
};

type GitProbe = {ok: boolean; status: number | null; stdout: string; stderr: string};

const probeGit = (projectRoot: string, args: string[]): GitProbe => {
	const result = spawnSync("git", args, {cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
	return {
		ok: !result.error && result.status === 0,
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
};

type PrimaryIndexGuardHookLocation = {hooksDirectory: string} | {error: string};

/** Resolve the shared hook directory; a repository-owned hooksPath is never replaced or redirected. */
const primaryIndexGuardHookLocation = (projectRoot: string): PrimaryIndexGuardHookLocation => {
	const commonDir = probeGit(projectRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonDir.ok || !commonDir.stdout.trim()) return {error: "could not resolve the shared Git common directory"};
	const configuredHooksPath = probeGit(projectRoot, ["config", "--get", "core.hooksPath"]);
	if (configuredHooksPath.ok && configuredHooksPath.stdout.trim()) {
		return {error: "core.hooksPath is configured; refusing to replace a repository-owned hook integration"};
	}
	if (configuredHooksPath.status !== 0 && configuredHooksPath.status !== 1) {
		return {error: "could not inspect core.hooksPath"};
	}
	return {hooksDirectory: join(commonDir.stdout.trim(), "hooks")};
};

const renderPrimaryIndexGuardHook = (): string => `#!/usr/bin/env sh
${PRIMARY_INDEX_GUARD_HOOK_MARKER}
# This hook deliberately blocks only the guard's dedicated exit 3. Runtime failures fail open.
project_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "primary-index-guard: unable to resolve repository root; allowing commit" >&2
  exit 0
}
pipeline="$project_root/.pipeline/toolkit/bin/pipeline"
if [ ! -x "$pipeline" ]; then
  echo "primary-index-guard: pinned pipeline binary is unavailable; allowing commit" >&2
  exit 0
fi
status=0
"$pipeline" cli primary-index-guard pre-commit || status=$?
if [ "$status" -eq 3 ]; then
  exit 1
fi
if [ "$status" -ne 0 ]; then
  echo "primary-index-guard: guard could not run (exit $status); allowing commit" >&2
fi
exit 0
`;

type PrimaryIndexGuardHookState = {state: "installed" | "missing-or-drifted"; path?: string; error?: string};

const primaryIndexGuardHookState = (projectRoot: string): PrimaryIndexGuardHookState => {
	const location = primaryIndexGuardHookLocation(projectRoot);
	if ("error" in location) return {state: "missing-or-drifted", error: location.error};
	const path = join(location.hooksDirectory, PRIMARY_INDEX_GUARD_HOOK_NAME);
	const stat = lstatSyncSafe(path);
	if (!stat) return {state: "missing-or-drifted", path, error: "managed pre-commit hook is missing"};
	if (!stat.isFile()) return {state: "missing-or-drifted", path, error: "pre-commit exists but is not a managed regular file"};
	try {
		if (readFileSync(path, "utf8") !== renderPrimaryIndexGuardHook()) {
			return {state: "missing-or-drifted", path, error: "pre-commit is not the expected managed primary-index-guard wrapper"};
		}
	} catch {
		return {state: "missing-or-drifted", path, error: "could not read the managed pre-commit hook"};
	}
	if ((stat.mode & 0o111) === 0) return {state: "missing-or-drifted", path, error: "managed pre-commit hook is not executable"};
	return {state: "installed", path};
};

const primaryIndexGuardHookIntegration = (): string => [
	"refusing to overwrite an unrelated pre-commit hook",
	"integrate this command in the existing hook and preserve its exit-3 mapping:",
	'  status=0; "$project_root/.pipeline/toolkit/bin/pipeline" cli primary-index-guard pre-commit || status=$?; [ "$status" -eq 3 ] && exit 1',
].join("\n");

const readAgentPolicy = (projectRoot: string): Record<string, unknown> | undefined =>
	parseAgentPolicy(safeJson(join(projectRoot, ".pipeline/agent-policy.json")));

const installPrimaryIndexGuardHook = (projectRoot: string): void => {
	assertToolkit(projectRoot);
	const policy = readAgentPolicy(projectRoot) ?? fail(".pipeline/agent-policy.json has an unsupported shape");
	if (!primaryIndexGuardPolicy(policy)?.enabled) fail("primary-index-guard is disabled by repository policy; enable it before installing a hook");
	const location = primaryIndexGuardHookLocation(projectRoot);
	const hooksDirectory = "hooksDirectory" in location ? location.hooksDirectory : fail(location.error);
	const path = join(hooksDirectory, PRIMARY_INDEX_GUARD_HOOK_NAME);
	const existing = lstatSyncSafe(path);
	if (existing) {
		let managed = false;
		try { managed = existing.isFile() && readFileSync(path, "utf8").includes(PRIMARY_INDEX_GUARD_HOOK_MARKER); } catch {}
		if (!managed) fail(primaryIndexGuardHookIntegration());
	} else {
		mkdirSync(hooksDirectory, {recursive: true});
	}
	writeFileSync(path, renderPrimaryIndexGuardHook());
	chmodSync(path, 0o755);
	console.log(`pipeline: installed primary-index-guard hook at ${path}`);
};

const checkPrimaryIndexGuardHook = (projectRoot: string): string | undefined => {
	const policy = readAgentPolicy(projectRoot);
	if (!policy) return ".pipeline/agent-policy.json has an unsupported shape";
	const guard = primaryIndexGuardPolicy(policy);
	if (!guard?.enabled) return undefined;
	const hook = primaryIndexGuardHookState(projectRoot);
	return hook.state === "installed" ? undefined : hook.error ?? "managed pre-commit hook is missing or drifted";
};

/**
 * Remove every path a previous install managed that this one no longer does.
 *
 * Without this, dropping an artifact from the payload strands it: the adopter updates the toolkit
 * submodule, the skill directory it pointed at disappears, and the symlink stays behind pointing at
 * nothing. Nobody notices, because a dangling entry in `.claude/skills/` fails by not matching
 * rather than by erroring — the same silent shape the whole toolkit refuses elsewhere.
 *
 * It removes a path **only when it is still the link we recorded**, exactly as
 * `retireLegacyPluginLink` does. A path the adopter has since replaced with their own file is
 * theirs, and unmanaging something is never a licence to delete it.
 */
const retireUnmanagedPaths = (
	projectRoot: string,
	prior: Map<string, string>,
	managedPaths: ReadonlyArray<ManagedPath>,
): string[] => {
	const kept = new Set(managedPaths.map((entry) => entry.path));
	const retired: string[] = [];
	for (const [path, target] of prior) {
		if (kept.has(path)) continue;
		const absolute = join(projectRoot, path);
		if (!lstatSyncSafe(absolute)?.isSymbolicLink()) continue;
		if (readlinkSync(absolute) !== target) continue;
		rmSync(absolute, {recursive: true, force: true});
		retired.push(path);
	}
	return retired;
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

/** The terminals the crew launcher can place its panes in — the `terminal` config dimension's vocabulary. */
const CREW_TERMINALS = new Set(["tmux", "herdr"]);
/** The terminal a crew config launches under when it omits the dimension entirely. */
const DEFAULT_CREW_TERMINAL = "tmux";

/**
 * Drop JSONC comments while leaving string literals intact, so a key regex can never match text that
 * only appears in a comment. The shipped crew template documents the `terminal` dimension in prose
 * directly above it, which is exactly the case a naive match would get wrong.
 */
const stripJsoncComments = (text: string): string => {
	let out = "";
	let inString = false, inLine = false, inBlock = false, escaped = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (char === "\n") { inLine = false; out += char; }
			continue;
		}
		if (inBlock) {
			if (char === "*" && next === "/") { inBlock = false; i += 1; }
			continue;
		}
		if (inString) {
			out += char;
			if (escaped) escaped = false;
			else if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') { inString = true; out += char; continue; }
		if (char === "/" && next === "/") { inLine = true; i += 1; continue; }
		if (char === "/" && next === "*") { inBlock = true; i += 1; continue; }
		out += char;
	}
	return out;
};

/**
 * The terminal the operator's crew config selects, or `undefined` when the config is absent/unreadable.
 * An omitted dimension is not a distinct state here — it simply means the default — so it resolves to
 * `tmux`, matching how the launcher's own typed reader folds it.
 */
const crewTerminal = (projectRoot: string): string | undefined => {
	try {
		const text = stripJsoncComments(readFileSync(join(projectRoot, CREW_CONFIG_RELATIVE_PATH), "utf8"));
		return /"terminal"\s*:\s*"([^"]*)"/.exec(text)?.[1] ?? DEFAULT_CREW_TERMINAL;
	} catch {
		return undefined;
	}
};

/**
 * Verify the terminal the crew will actually launch into is installed. The launcher only ever uses a
 * multiplexer as a window manager, but a missing binary still fails the whole stand-up — so it is worth
 * catching here, at install time, rather than when the operator first tries to boot a crew.
 *
 * Deliberately scoped to a PERSONALIZED crew config. A config still carrying `<placeholders>` means the
 * crew is not set up yet (`init` says as much on its own line), and a repo that never stands a crew up
 * must not be made to install tmux to pass a check — which is also why CI, where the git-ignored crew
 * config is simply absent, is unaffected.
 */
const checkCrewTerminal = (projectRoot: string): string | undefined => {
	if (hasCrewConfigPlaceholders(projectRoot)) return undefined;
	const terminal = crewTerminal(projectRoot);
	if (terminal === undefined) return undefined;
	if (!CREW_TERMINALS.has(terminal)) {
		return `unsupported crew terminal in ${CREW_CONFIG_RELATIVE_PATH}: ${terminal} (expected one of ${Array.from(CREW_TERMINALS).join(", ")})`;
	}
	if (!commandExists(terminal)) {
		return `missing required command for the configured crew terminal: ${terminal} (set "terminal" in ${CREW_CONFIG_RELATIVE_PATH}, or install ${terminal})`;
	}
	return undefined;
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
	run("pnpm", ["--filter", "pipeline-cli", "build"], toolkitRoot);
};

/** Linked worktrees share the primary checkout's hook directory; install only from its owner. */
const isPrimaryCheckout = (projectRoot: string): boolean =>
	run("git", ["rev-parse", "--git-dir"], projectRoot) === run("git", ["rev-parse", "--git-common-dir"], projectRoot);

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
	const parsedAgentPolicy = readAgentPolicy(projectRoot);
	const policy = parsedAgentPolicy ? "valid" : "missing-or-malformed";
	const primaryIndexGuard = parsedAgentPolicy ? primaryIndexGuardPolicy(parsedAgentPolicy) : undefined;
	const optionalPolicy = parseOptionalWorkflowPolicy(safeJson(join(projectRoot, ".pipeline/optional-workflow-policy.json")));
	const expectedCatalog = expectedLinkTarget(projectRoot, toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH, WORKFLOW_CATALOG_CONSUMER_PATH);
	const catalogue = existsSync(join(toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH)) &&
		readFileSync(join(toolkitRoot, WORKFLOW_CATALOG_RELATIVE_PATH), "utf8") === renderWorkflowCatalog() &&
		managedLinkState(projectRoot, config, WORKFLOW_CATALOG_CONSUMER_PATH, expectedCatalog) === "installed"
		? "current" : "missing-or-drifted";
	const primaryIndexGuardStatus: StatusItem[] = primaryIndexGuard?.enabled
		? (() => {
			const hook = primaryIndexGuardHookState(projectRoot);
			return [{name: "primary-index-guard", type: "git-hook", state: hook.state, ...(hook.path ? {path: hook.path} : {})}];
		})()
		: [];
	const core: StatusItem[] = [
		...Array.from(CORE_SKILL_NAMES).map((name) => ({name, type: "skill", path: `.claude/skills/${name}`,
			state: managedLinkState(projectRoot, config, `.claude/skills/${name}`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/skills/${name}`, `.claude/skills/${name}`))})),
		...Array.from(CORE_WORKFLOW_SUPPORT_FILES).map((name) => ({name, type: "support-file", path: `.claude/skills/${name}`,
			state: managedLinkState(projectRoot, config, `.claude/skills/${name}`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/skills/${name}`, `.claude/skills/${name}`))})),
		...Array.from(CORE_AGENT_NAMES).map((name) => ({name, type: "agent", path: `.claude/agents/${name}.md`,
			state: managedLinkState(projectRoot, config, `.claude/agents/${name}.md`, expectedLinkTarget(projectRoot, toolkitRoot, `claude-plugins/kampus-pipeline/agents/${name}.md`, `.claude/agents/${name}.md`))})),
		...GITHUB_WORKFLOW_TEMPLATES.map((template): StatusItem => ({name: template.destination, type: "generated-workflow", path: template.destination,
			state: config?.managedPaths.some((entry) => entry.path === template.destination && entry.target === `template:${template.source}`) && existsSync(join(projectRoot, template.destination)) ? "installed" : "missing-or-drifted"})),
		...(["main-sync", "trivial-diff classify", "class-probe classify", "guard-content-probe", "cp-cardinality decide", "cp-cardinality evidence-github-team", "reachability-guard check", "worktree-sweep", "gh-compat lint-skills", "ship-digest derive", "primary-index-guard pre-commit"] as const).map((name): StatusItem => ({name, type: "cli-command", path: ".pipeline/toolkit/bin/pipeline",
			state: existsSync(join(projectRoot, ".pipeline/toolkit/bin/pipeline")) ? "installed" : "missing-or-drifted"})),
		...primaryIndexGuardStatus,
	];
	const optional = GITHUB_WORKFLOW_TEMPLATES.map((template) => {
		const name = basename(template.destination, ".yml");
		const enabled = optionalPolicy?.workflows[name]?.enabled === true;
		const state = !enabled
			? ("disabled" as const)
			: existsSync(join(projectRoot, template.destination))
				? ("installed" as const)
				: ("missing-or-drifted" as const);
		return {name, type: "optional-workflow", state, path: template.destination};
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
	const terminalError = checkCrewTerminal(projectRoot);
	if (terminalError) errors.push(terminalError);
	const config = readConfig(projectRoot);
	if (toolkitRoot && config?.toolkitRoot !== TOOLKIT_RELATIVE_PATH) errors.push("pipeline config has an unsupported toolkit path");
	if (!config) {
		errors.push("missing " + CONFIG_RELATIVE_PATH);
		return errors;
	}
	const agentPolicyPath = join(projectRoot, ".pipeline/agent-policy.json");
	let agentPolicy: Record<string, unknown> | undefined;
	try {
		const policy = parseAgentPolicy(JSON.parse(readFileSync(agentPolicyPath, "utf8")) as unknown);
		if (!policy) {
			errors.push("agent policy has an unsupported shape");
		} else agentPolicy = policy;
	} catch {
		errors.push("missing or invalid .pipeline/agent-policy.json");
	}
	if (agentPolicy && primaryIndexGuardPolicy(agentPolicy)?.enabled) {
		const hookError = checkPrimaryIndexGuardHook(projectRoot);
		if (hookError) errors.push(`primary-index-guard hook: ${hookError}`);
	}
	let enabledWorkflowFiles = new Set<string>();
	const optionalWorkflowPolicyPath = join(projectRoot, ".pipeline/optional-workflow-policy.json");
	try {
		const policy = parseOptionalWorkflowPolicy(JSON.parse(readFileSync(optionalWorkflowPolicyPath, "utf8")) as unknown);
		if (!policy) errors.push("optional-workflow policy has an unsupported shape");
		else enabledWorkflowFiles = enabledWorkflowFileNames(policy);
	} catch {
		errors.push("missing or invalid .pipeline/optional-workflow-policy.json");
	}
	// The refusal `init` enforces, reported as drift: under self-host an enabled consumer-shaped
	// workflow can never be reconciled (#26), so the flag itself is the error. The resolved set is
	// then emptied — a materialized copy reds below as installed without valid enablement.
	if (enabledWorkflowFiles.size > 0 && isSelfHostedToolkit(projectRoot)) {
		for (const name of enabledWorkflowFiles) {
			errors.push(`consumer-shaped workflow is enabled in the self-hosted toolkit repository: ${name} (#26)`);
		}
		enabledWorkflowFiles = new Set();
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
		for (const template of GITHUB_WORKFLOW_TEMPLATES) {
			const name = basename(template.destination, ".yml");
			const present = managedPaths.has(template.destination);
			// Both directions are errors: a workflow present without being enabled was installed by
			// something that did not consult the policy, and an enabled one that is absent means the
			// adopter asked for a check they are not getting.
			if (present && !enabledWorkflowFiles.has(name)) errors.push(`workflow installed without being enabled in policy: ${name}`);
			if (enabledWorkflowFiles.has(name) && !present) errors.push(`enabled workflow is not installed: ${name}`);
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
	const enabledWorkflowFiles = enabledWorkflowFileNames(optionalWorkflowPolicy);
	// `enable` refuses under self-host before touching the policy, but the policy is plain JSON and
	// hand-edit-then-`sync` is a supported flow — so the refusal also guards the materialization
	// site itself. A consumer-shaped workflow in this repository would gate a checkout of itself —
	// green, and confirming nothing (#26).
	if (enabledWorkflowFiles.size > 0 && isSelfHostedToolkit(projectRoot)) {
		fail(`cannot materialize workflow(s) ${Array.from(enabledWorkflowFiles).join(", ")}: the optional workflows are consumer-shaped, and this repository hosts the toolkit itself (#26); disable them in .pipeline/optional-workflow-policy.json`);
	}
	// Opt-in only. A workflow the adopter did not ask for becomes a required check they did not
	// choose, and a red one blocks the merge gate over something that is not their change (#32).
	const githubWorkflows = GITHUB_WORKFLOW_TEMPLATES.flatMap((template) => {
		const name = basename(template.destination, ".yml");
		if (!enabledWorkflowFiles.has(name)) {
			// Disabling has to UNINSTALL, not merely stop reinstalling. Leaving the file behind keeps
			// the check running in the adopter's CI after they turned it off, and `check` would then
			// red on a workflow present without being enabled — forever, with no way to clear it.
			// Only a copy we manage is removed; an adopter's own file of the same name is untouched.
			if (prior.has(template.destination)) rmSync(join(projectRoot, template.destination), {force: true});
			return [];
		}
		const managed = materializeTemplate(projectRoot, toolkitRoot, template.source, template.destination, prior);
		return managed ? [managed] : [];
	});
	const managedHooks = mergeSettings(projectRoot, toolkitRoot);
	mergePackageScript(projectRoot);
	// Ref safety is core checkout containment, installed the way a hook manager's `prepare` step
	// would install it. The command is idempotent and refuses a foreign hook instead of silently
	// taking another hook manager's ownership.
	if (isPrimaryCheckout(projectRoot)) run(join(toolkitRoot, "bin/pipeline"), ["cli", "ref-guard", "install"], projectRoot);
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
			(CORE_WORKFLOW_SUPPORT_FILES.has(name) && existsSync(join(toolkitRoot, "claude-plugins/kampus-pipeline/skills", name))),
		force, prior),
	];
	const retired = retireUnmanagedPaths(projectRoot, prior, managedPaths);
	writeJson(join(projectRoot, CONFIG_RELATIVE_PATH), {schemaVersion: 4, toolkitRoot: TOOLKIT_RELATIVE_PATH, managedPaths, managedHooks} satisfies PipelineConfig);
	if (retired.length) console.error(`pipeline: retired ${retired.length} path(s) no longer in the payload:\n${retired.map((path) => `- ${path}`).join("\n")}`);
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
		?? fail(`workflow name is required; available: ${GITHUB_WORKFLOW_TEMPLATES.map((template) => basename(template.destination, ".yml")).join(", ")}`);
	if (!GITHUB_WORKFLOW_TEMPLATES.some((template) => basename(template.destination, ".yml") === workflow)) {
		fail(`workflow is not optional or does not exist: ${workflow}`);
	}
	const projectRoot = findProjectRoot(requested);
	// The optional workflows are consumer-shaped: they pin `.pipeline/toolkit` in CI and gate the
	// pull request on it. In the self-hosted toolkit repository that gates a checkout of itself —
	// green, and confirming nothing (#26) — so the refusal lands before the policy is touched,
	// leaving nothing behind for a later `sync` to materialize.
	if (isSelfHostedToolkit(projectRoot)) fail(`cannot enable ${workflow}: the optional workflows are consumer-shaped, and this repository hosts the toolkit itself (#26)`);
	const policy = readOptionalWorkflowPolicy(projectRoot);
	policy.workflows[workflow] = {...policy.workflows[workflow], enabled: true};
	writeJson(join(projectRoot, ".pipeline/optional-workflow-policy.json"), policy);
	init(["--project-root", projectRoot]);
	const errors = check(projectRoot);
	if (errors.length) fail(`enable failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	console.log(`pipeline: enabled ${workflow}; it will run on the next pull request`);
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

const primaryIndexGuard = (args: string[]): void => {
	const [action, ...rest] = args;
	if (action !== "install-hook" && action !== "check-hook") {
		fail("usage: pipeline primary-index-guard <install-hook|check-hook> [--project-root <path>]");
	}
	const requested = rest.includes("--project-root") ? rest[rest.indexOf("--project-root") + 1] : undefined;
	if (rest.includes("--project-root") && !requested) fail("--project-root requires a path");
	const unknown = rest.filter((arg) => arg !== "--project-root" && arg !== requested);
	if (unknown.length) fail(`unknown primary-index-guard argument(s): ${unknown.join(", ")}`);
	const projectRoot = findProjectRoot(requested);
	if (action === "install-hook") {
		installPrimaryIndexGuardHook(projectRoot);
		return;
	}
	const policy = readAgentPolicy(projectRoot) ?? fail(".pipeline/agent-policy.json has an unsupported shape");
	const guard = primaryIndexGuardPolicy(policy);
	if (!guard?.enabled) {
		console.log("pipeline: primary-index-guard is disabled by repository policy; no hook is required");
		return;
	}
	const hook = primaryIndexGuardHookState(projectRoot);
	if (hook.state !== "installed") fail(`primary-index-guard hook check failed: ${hook.error ?? "missing or drifted managed hook"}`);
	console.log(`pipeline: primary-index-guard hook check passed (${hook.path})`);
};

const forward = (packagePath: string, args: string[]): never => {
	const result = spawnSync("node", ["--experimental-strip-types", join(sourceToolkitRoot, packagePath), ...args], {stdio: "inherit"});
	process.exit(result.status ?? 1);
};

const [command, ...args] = process.argv.slice(2);
if (command === "init" || command === "sync") init(args);
else if (command === "enable") enable(args);
else if (command === "status") status(args);
else if (command === "primary-index-guard") primaryIndexGuard(args);
else if (command === "check") {
	const errors = check(findProjectRoot(args[0]));
	if (errors.length) fail(`check failed:\n${errors.map((error) => `- ${error}`).join("\n")}`);
	console.log("pipeline: check passed");
} else if (command === "cli") {
	if (!args[0]) fail("CLI tool is required");
	forward("packages/pipeline-cli/src/bin.ts", args);
}
else if (command === "crew") forward("packages/pipeline-crew-mcp/src/bin.ts", args);
else fail("usage: pipeline <init|sync|check|status|enable|primary-index-guard|cli|crew> [args]");
