import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {InventoryTags} from "./design-inventory.ts";
const POLICY_PATH = ".pipeline/optional-workflow-policy.json";
export type DesignInventoryPolicy = {readonly enabled: boolean; readonly sourceGlobs: ReadonlyArray<string>; readonly artifactPath: string | null; readonly normativeArtifactPaths: ReadonlyArray<string>; readonly tags: InventoryTags | null};
export type LoadedDesignInventoryPolicy = {readonly policy: DesignInventoryPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const relativePath = (value: string): boolean => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const strings = (value: unknown, permitEmpty: boolean): ReadonlyArray<string> | null => Array.isArray(value) && (permitEmpty || value.length > 0) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value : null;
const disabled = (): DesignInventoryPolicy => ({enabled: false, sourceGlobs: [], artifactPath: null, normativeArtifactPaths: [], tags: null});
export const parseDesignInventoryPolicy = (raw: unknown): DesignInventoryPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workflows)) return null;
	if (raw.adapters === undefined) return disabled(); if (!isRecord(raw.adapters)) return null;
	if (raw.adapters.designInventory === undefined) return disabled(); if (!isRecord(raw.adapters.designInventory)) return null;
	const configured = raw.adapters.designInventory; if (typeof configured.enabled !== "boolean") return null;
	const sourceGlobs = strings(configured.sourceGlobs, !configured.enabled); const normativeArtifactPaths = strings(configured.normativeArtifactPaths, true);
	const artifactPath = configured.artifactPath; const rawTags = configured.tags;
	if (sourceGlobs === null || normativeArtifactPaths === null || (artifactPath !== null && (typeof artifactPath !== "string" || !relativePath(artifactPath))) || sourceGlobs.some((path) => !relativePath(path)) || normativeArtifactPaths.some((path) => !relativePath(path))) return null;
	if (!configured.enabled) { if (sourceGlobs.length || normativeArtifactPaths.length || artifactPath !== null || rawTags !== null) return null; return disabled(); }
	if (!isRecord(rawTags) || sourceGlobs.length === 0 || artifactPath === null || normativeArtifactPaths.includes(artifactPath)) return null;
	const values = [rawTags.component, rawTags.whenToUse, rawTags.slot, rawTags.directive];
	if (!values.every((value) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9]*$/.test(value))) return null;
	return {enabled: true, sourceGlobs, artifactPath, normativeArtifactPaths, tags: {component: rawTags.component as string, whenToUse: rawTags.whenToUse as string, slot: rawTags.slot as string, directive: rawTags.directive as string}};
};
export const readDesignInventoryPolicy = (root: string): LoadedDesignInventoryPolicy => { const source = join(root, POLICY_PATH); if (!existsSync(source)) return {policy: null, trusted: false, source, reason: "optional adapter policy could not be read"}; try { const policy = parseDesignInventoryPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown); return policy === null ? {policy: null, trusted: false, source, reason: "design-inventory policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null}; } catch { return {policy: null, trusted: false, source, reason: "optional adapter policy is not valid JSON"}; } };
