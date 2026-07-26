import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {
	normalizeProtectedPathPrefix,
	type PrimaryIndexGuardPolicy,
} from "./primary-index-guard.ts";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type PrimaryIndexPolicyLoad =
	| {readonly trusted: true; readonly policy: PrimaryIndexGuardPolicy; readonly source: string}
	| {readonly trusted: false; readonly policy: null; readonly source: string; readonly reason: string};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Parse the guard's additive policy atomically; an untrusted partial policy is never enforced. */
export const parsePrimaryIndexGuardPolicy = (raw: unknown): PrimaryIndexGuardPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.git) || !isRecord(raw.git.primaryIndexGuard)) return null;
	const guard = raw.git.primaryIndexGuard;
	if (typeof guard.enabled !== "boolean" || !Array.isArray(guard.protectedPathPrefixes) || !positiveInteger(guard.blockThreshold)) return null;
	if (!guard.protectedPathPrefixes.every((prefix) => typeof prefix === "string")) return null;
	const prefixes = (guard.protectedPathPrefixes as readonly string[]).map(normalizeProtectedPathPrefix);
	if (prefixes.some((prefix) => prefix === null)) return null;
	const normalizedPrefixes = prefixes as readonly string[];
	if (new Set(normalizedPrefixes).size !== normalizedPrefixes.length) return null;
	if (guard.enabled && normalizedPrefixes.length === 0) return null;
	if (!isRecord(guard.attribution) || typeof guard.attribution.enabled !== "boolean" || !positiveInteger(guard.attribution.threshold)) return null;
	const logPath = guard.attribution.logPath;
	if (logPath !== null && (typeof logPath !== "string" || logPath.trim() === "")) return null;
	if (guard.attribution.enabled && guard.attribution.threshold > guard.blockThreshold) return null;
	return {
		enabled: guard.enabled,
		protectedPathPrefixes: normalizedPrefixes,
		blockThreshold: guard.blockThreshold,
		attribution: {enabled: guard.attribution.enabled, threshold: guard.attribution.threshold, logPath},
	};
};

export const readPrimaryIndexGuardPolicy = (root: string): PrimaryIndexPolicyLoad => {
	const source = join(root, POLICY_PATH);
	if (!existsSync(source)) return {trusted: false, policy: null, source, reason: "policy file is unavailable"};
	try {
		const policy = parsePrimaryIndexGuardPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown);
		return policy === null
			? {trusted: false, policy: null, source, reason: "primary-index guard policy has an unsupported shape"}
			: {trusted: true, policy, source};
	} catch {
		return {trusted: false, policy: null, source, reason: "policy file is not valid JSON"};
	}
};
