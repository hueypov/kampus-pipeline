import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {Exemption, GovernedDecision} from "./adoption-lint.ts";

const POLICY_PATH = ".pipeline/optional-workflow-policy.json";

export type AdoptionPolicy = { readonly enabled: boolean; readonly corpusGlobs: ReadonlyArray<string>; readonly decisions: ReadonlyArray<GovernedDecision>; readonly exemptions: ReadonlyArray<Exemption>; };
export type LoadedAdoptionPolicy = {readonly policy: AdoptionPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown, allowEmpty: boolean): ReadonlyArray<string> | null =>
	Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value : null;
const validRegexes = (items: ReadonlyArray<string>): boolean => { try { items.forEach((item) => new RegExp(item)); return true; } catch { return false; } };
const normalizedPath = (value: string): boolean => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");

const decisions = (value: unknown): ReadonlyArray<GovernedDecision> | null => {
	if (!Array.isArray(value)) return null;
	const parsed: GovernedDecision[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.id !== "string" || !item.id.trim() || typeof item.authority !== "string" || !item.authority.trim() || typeof item.reason !== "string" || !item.reason.trim()) return null;
		const signaturePatterns = strings(item.signaturePatterns, false);
		const evidencePatterns = strings(item.evidencePatterns, false);
		if (signaturePatterns === null || evidencePatterns === null || !validRegexes(signaturePatterns) || !validRegexes(evidencePatterns)) return null;
		parsed.push({id: item.id, authority: item.authority, signature: signaturePatterns.map((pattern) => new RegExp(pattern)), evidence: evidencePatterns.map((pattern) => new RegExp(pattern)), reason: item.reason});
	}
	return new Set(parsed.map((item) => item.id)).size === parsed.length ? parsed : null;
};

const exemptions = (value: unknown): ReadonlyArray<Exemption> | null => {
	if (!Array.isArray(value)) return null;
	const parsed: Exemption[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.path !== "string" || !normalizedPath(item.path) || typeof item.reason !== "string" || !item.reason.trim()) return null;
		if (item.kind === "mirror") parsed.push({kind: "mirror", path: item.path, reason: item.reason});
		else if (item.kind === "grandfathered" && typeof item.decision === "string" && item.decision.trim()) parsed.push({kind: "grandfathered", path: item.path, decision: item.decision, reason: item.reason});
		else return null;
	}
	return parsed;
};

/** Parse the complete optional adapter atomically; no source corpus is implied when disabled. */
export const parseAdoptionPolicy = (raw: unknown): AdoptionPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.workflows)) return null;
	if (raw.adapters === undefined) return {enabled: false, corpusGlobs: [], decisions: [], exemptions: []};
	if (!isRecord(raw.adapters)) return null;
	if (raw.adapters.adoptionLint === undefined) return {enabled: false, corpusGlobs: [], decisions: [], exemptions: []};
	if (!isRecord(raw.adapters.adoptionLint)) return null;
	const configured = raw.adapters.adoptionLint;
	if (typeof configured.enabled !== "boolean") return null;
	const corpusGlobs = strings(configured.corpusGlobs, !configured.enabled);
	const concepts = decisions(configured.decisions);
	const declaredExemptions = exemptions(configured.exemptions);
	if (corpusGlobs === null || concepts === null || declaredExemptions === null || corpusGlobs.some((glob) => !normalizedPath(glob))) return null;
	if (!configured.enabled && (corpusGlobs.length || concepts.length || declaredExemptions.length)) return null;
	if (configured.enabled && (corpusGlobs.length === 0 || concepts.length === 0)) return null;
	if (declaredExemptions.some((item) => item.kind === "grandfathered" && !concepts.some((decision) => decision.id === item.decision))) return null;
	return {enabled: configured.enabled, corpusGlobs, decisions: concepts, exemptions: declaredExemptions};
};

export const readAdoptionPolicy = (root: string): LoadedAdoptionPolicy => {
	const source = join(root, POLICY_PATH);
	if (!existsSync(source)) return {policy: null, trusted: false, source, reason: "optional adapter policy could not be read"};
	try {
		const policy = parseAdoptionPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown);
		return policy === null ? {policy: null, trusted: false, source, reason: "adoption-lint policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null};
	} catch { return {policy: null, trusted: false, source, reason: "optional adapter policy is not valid JSON"}; }
};
