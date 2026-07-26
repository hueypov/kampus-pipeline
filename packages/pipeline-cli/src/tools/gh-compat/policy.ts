import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

export type GhCompatibilityPolicy = {
	readonly enabled: boolean;
	readonly targetRepository: string | null;
	readonly realGhPath: string | null;
	readonly pathShimEnabled: boolean;
	readonly graphql: {
		readonly mode: "passthrough" | "rest-only";
		readonly blockVerbs: ReadonlyArray<string>;
		readonly unsupportedJsonFields: ReadonlyArray<string>;
		readonly rewriteIssueAndPrEdit: boolean;
	};
	readonly skillLint: {
		readonly strictYamlFrontmatter: boolean;
		readonly forbidConfiguredGraphqlPaths: boolean;
		readonly selfExemptPaths: ReadonlyArray<string>;
	};
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
	value === null || (typeof value === "string" && value.trim() !== "") ? value : null;

const strings = (value: unknown): ReadonlyArray<string> | null =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
		? value
		: null;

/** The safe baseline: the command exists, but no repository gets a GitHub compatibility restriction by default. */
export const DEFAULT_GH_COMPATIBILITY_POLICY: GhCompatibilityPolicy = {
	enabled: false,
	targetRepository: null,
	realGhPath: null,
	pathShimEnabled: false,
	graphql: {
		mode: "passthrough",
		blockVerbs: [],
		unsupportedJsonFields: [],
		rewriteIssueAndPrEdit: false,
	},
	skillLint: {strictYamlFrontmatter: true, forbidConfiguredGraphqlPaths: false, selfExemptPaths: []},
};

/** Resolve the repository root without guessing outside a Git checkout. */
export const repositoryRoot = (cwd = process.cwd()): string | null => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null;
	} catch {
		return null;
	}
};

/**
 * Parse only this tool's additive policy. An absent section means the safe baseline; a present
 * malformed section is untrusted and returns null so callers can refuse compatibility rewrites.
 */
export const readGhCompatibilityPolicy = (root: string): GhCompatibilityPolicy | null => {
	const path = join(root, ".pipeline/agent-policy.json");
	if (!existsSync(path)) return DEFAULT_GH_COMPATIBILITY_POLICY;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github)) return null;
		const compatibility = raw.github.cliCompatibility;
		if (compatibility === undefined) return DEFAULT_GH_COMPATIBILITY_POLICY;
		if (!isRecord(compatibility) || typeof compatibility.enabled !== "boolean") return null;
		const targetRepository = stringOrNull(compatibility.targetRepository);
		const realGhPath = stringOrNull(compatibility.realGhPath);
		const pathShim = compatibility.pathShim;
		const graphql = compatibility.graphql;
		const skillLint = compatibility.skillLint;
		if (
			targetRepository === null && compatibility.targetRepository !== null && compatibility.targetRepository !== undefined ||
			realGhPath === null && compatibility.realGhPath !== null && compatibility.realGhPath !== undefined ||
			!isRecord(pathShim) || typeof pathShim.enabled !== "boolean" ||
			!isRecord(graphql) || (graphql.mode !== "passthrough" && graphql.mode !== "rest-only") ||
			strings(graphql.blockVerbs) === null || strings(graphql.unsupportedJsonFields) === null ||
			typeof graphql.rewriteIssueAndPrEdit !== "boolean" ||
			!isRecord(skillLint) || typeof skillLint.strictYamlFrontmatter !== "boolean" ||
			typeof skillLint.forbidConfiguredGraphqlPaths !== "boolean" || strings(skillLint.selfExemptPaths) === null
		) return null;
		return {
			enabled: compatibility.enabled,
			targetRepository,
			realGhPath,
			pathShimEnabled: pathShim.enabled,
			graphql: {
				mode: graphql.mode,
				blockVerbs: strings(graphql.blockVerbs) ?? [],
				unsupportedJsonFields: strings(graphql.unsupportedJsonFields) ?? [],
				rewriteIssueAndPrEdit: graphql.rewriteIssueAndPrEdit,
			},
			skillLint: {
				strictYamlFrontmatter: skillLint.strictYamlFrontmatter,
				forbidConfiguredGraphqlPaths: skillLint.forbidConfiguredGraphqlPaths,
				selfExemptPaths: strings(skillLint.selfExemptPaths) ?? [],
			},
		};
	} catch {
		return null;
	}
};
