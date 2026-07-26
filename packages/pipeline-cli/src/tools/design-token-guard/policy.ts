import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {TokenRule} from "./design-token-guard.ts";

const POLICY_PATH = ".pipeline/optional-workflow-policy.json";
export type DesignTokenPolicy = {readonly enabled: boolean; readonly sourceGlobs: ReadonlyArray<string>; readonly rule: TokenRule};
export type LoadedDesignTokenPolicy = {readonly policy: DesignTokenPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, permitEmpty: boolean): ReadonlyArray<string> | null => Array.isArray(value) && (permitEmpty || value.length > 0) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value : null;
const relativePath = (value: string): boolean => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const regex = (value: unknown): RegExp | null => { if (typeof value !== "string" || !value) return null; try { return new RegExp(value, "g"); } catch { return null; } };
const ceilings = (value: unknown): Readonly<Record<string, number>> | null => {
	if (!isRecord(value)) return null;
	for (const [path, ceiling] of Object.entries(value)) if (!relativePath(path) || typeof ceiling !== "number" || !Number.isInteger(ceiling) || ceiling < 0) return null;
	return value as Record<string, number>;
};
const disabled = (): DesignTokenPolicy => ({enabled: false, sourceGlobs: [], rule: {referencePattern: /$^/g, declarationPattern: /$^/g, hexLiteralPattern: /$^/g, rawPxPattern: /$^/g, rawPxThreshold: 0, rawLayerPaths: [], externalProperties: [], grandfatheredMissingTokens: [], rawPxCeilings: {}}});

/** Parse this one optional adapter atomically: no CSS convention is inferred. */
export const parseDesignTokenPolicy = (raw: unknown): DesignTokenPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workflows)) return null;
	if (raw.adapters === undefined) return disabled();
	if (!isRecord(raw.adapters)) return null;
	if (raw.adapters.designTokenGuard === undefined) return disabled();
	if (!isRecord(raw.adapters.designTokenGuard)) return null;
	const configured = raw.adapters.designTokenGuard;
	if (typeof configured.enabled !== "boolean") return null;
	const sourceGlobs = strings(configured.sourceGlobs, !configured.enabled);
	const rawLayerPaths = strings(configured.rawLayerPaths, true);
	const externalProperties = strings(configured.externalProperties, true);
	const grandfatheredMissingTokens = strings(configured.grandfatheredMissingTokens, true);
	const referencePattern = regex(configured.referencePattern);
	const declarationPattern = regex(configured.declarationPattern);
	const hexLiteralPattern = regex(configured.hexLiteralPattern);
	const rawPxPattern = regex(configured.rawPxPattern);
	const rawPxCeilings = ceilings(configured.rawPxCeilings);
	if (sourceGlobs === null || rawLayerPaths === null || externalProperties === null || grandfatheredMissingTokens === null || rawPxCeilings === null) return null;
	if (!configured.enabled) {
		if (sourceGlobs.length || rawLayerPaths.length || externalProperties.length || grandfatheredMissingTokens.length || Object.keys(rawPxCeilings).length || configured.referencePattern !== null || configured.declarationPattern !== null || configured.hexLiteralPattern !== null || configured.rawPxPattern !== null || configured.rawPxThreshold !== null) return null;
		return disabled();
	}
	if (!referencePattern || !declarationPattern || !hexLiteralPattern || !rawPxPattern || typeof configured.rawPxThreshold !== "number" || !Number.isFinite(configured.rawPxThreshold) || configured.rawPxThreshold < 0 || sourceGlobs.some((glob) => !relativePath(glob)) || rawLayerPaths.some((path) => !relativePath(path))) return null;
	return {enabled: true, sourceGlobs, rule: {referencePattern, declarationPattern, hexLiteralPattern, rawPxPattern, rawPxThreshold: configured.rawPxThreshold, rawLayerPaths, externalProperties, grandfatheredMissingTokens, rawPxCeilings}};
};
export const readDesignTokenPolicy = (root: string): LoadedDesignTokenPolicy => {
	const source = join(root, POLICY_PATH);
	if (!existsSync(source)) return {policy: null, trusted: false, source, reason: "optional adapter policy could not be read"};
	try { const policy = parseDesignTokenPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown); return policy === null ? {policy: null, trusted: false, source, reason: "design-token-guard policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null}; }
	catch { return {policy: null, trusted: false, source, reason: "optional adapter policy is not valid JSON"}; }
};
