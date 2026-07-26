import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {AllowlistEntry, CatalogRule} from "./catalog-guard.ts";

const POLICY_PATH = ".pipeline/optional-workflow-policy.json";

export type CatalogPolicy = {
	readonly enabled: boolean;
	readonly packageManager: "pnpm-catalog" | null;
	readonly workspaceManifest: string | null;
	readonly packageGlobs: ReadonlyArray<string>;
	readonly dependencyFields: ReadonlyArray<string>;
	readonly catalogNames: ReadonlyArray<string>;
	readonly rule: CatalogRule;
};

export type LoadedCatalogPolicy = {readonly policy: CatalogPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, allowEmpty: boolean): ReadonlyArray<string> | null =>
	Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => typeof entry === "string" && entry.trim() !== "") ? value : null;
const normalizedPath = (value: string): boolean => value === "." || (!value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

const allowlist = (value: unknown): ReadonlyArray<AllowlistEntry> | null => {
	if (!Array.isArray(value)) return null;
	const items: AllowlistEntry[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim() || typeof item.reason !== "string" || !item.reason.trim()) return null;
		if (item.path !== undefined && (typeof item.path !== "string" || !normalizedPath(item.path))) return null;
		items.push({name: item.name, reason: item.reason, ...(typeof item.path === "string" ? {path: item.path} : {})});
	}
	return items;
};

/** Parse the entire adapter atomically. Disabled means no convention is silently activated. */
export const parseCatalogPolicy = (raw: unknown): CatalogPolicy | null => {
	const disabled = (): CatalogPolicy => ({enabled: false, packageManager: null, workspaceManifest: null, packageGlobs: [], dependencyFields: [], catalogNames: [], rule: {allowedSpecifierPrefixes: [], catalogNames: [], allowlist: []}});
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workflows)) return null;
	if (raw.adapters === undefined) return disabled();
	if (!isRecord(raw.adapters)) return null;
	if (raw.adapters.catalogGuard === undefined) return disabled();
	if (!isRecord(raw.adapters.catalogGuard)) return null;
	const configured = raw.adapters.catalogGuard;
	if (typeof configured.enabled !== "boolean") return null;
	const packageManager = configured.packageManager;
	const workspaceManifest = configured.workspaceManifest;
	const packageGlobs = strings(configured.packageGlobs, !configured.enabled);
	const dependencyFields = strings(configured.dependencyFields, !configured.enabled);
	const catalogNames = strings(configured.catalogNames, true);
	const allowedSpecifierPrefixes = strings(configured.allowedSpecifierPrefixes, !configured.enabled);
	const exceptions = allowlist(configured.allowlist);
	if (packageGlobs === null || dependencyFields === null || catalogNames === null || allowedSpecifierPrefixes === null || exceptions === null) return null;
	if (workspaceManifest !== null && (typeof workspaceManifest !== "string" || !normalizedPath(workspaceManifest))) return null;
	if (!configured.enabled) {
		if (packageManager !== null || workspaceManifest !== null || packageGlobs.length || dependencyFields.length || catalogNames.length || allowedSpecifierPrefixes.length || exceptions.length) return null;
		return {enabled: false, packageManager: null, workspaceManifest: null, packageGlobs, dependencyFields, catalogNames, rule: {allowedSpecifierPrefixes, catalogNames, allowlist: exceptions}};
	}
	if (packageManager !== "pnpm-catalog" || workspaceManifest === null || packageGlobs.length === 0 || dependencyFields.length === 0 || allowedSpecifierPrefixes.length === 0) return null;
	if (packageGlobs.some((path) => !normalizedPath(path)) || dependencyFields.some((field) => !/^[A-Za-z][A-Za-z0-9]*$/.test(field))) return null;
	if (allowedSpecifierPrefixes.some((prefix) => !prefix.endsWith(":"))) return null;
	return {enabled: true, packageManager, workspaceManifest, packageGlobs, dependencyFields, catalogNames, rule: {allowedSpecifierPrefixes, catalogNames, allowlist: exceptions}};
};

export const readCatalogPolicy = (root: string): LoadedCatalogPolicy => {
	const source = join(root, POLICY_PATH);
	if (!existsSync(source)) return {policy: null, trusted: false, source, reason: "optional adapter policy could not be read"};
	try {
		const policy = parseCatalogPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown);
		return policy === null ? {policy: null, trusted: false, source, reason: "catalog-guard policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null};
	} catch {
		return {policy: null, trusted: false, source, reason: "optional adapter policy is not valid JSON"};
	}
};
