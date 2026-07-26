import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type FeatureReachabilityPolicy =
	| {readonly enabled: false}
	| {
			readonly enabled: true;
			readonly definitionsPath: string;
			readonly consumerRoots: ReadonlyArray<string>;
			readonly consumerFilePattern: RegExp;
			readonly journeyRoots: ReadonlyArray<string>;
			readonly journeyFilePattern: RegExp;
			readonly definitionPattern: RegExp;
			readonly journeyPattern: RegExp;
			readonly exemptionPattern: RegExp;
	  };

export type LoadedFeatureReachabilityPolicy = {
	readonly policy: FeatureReachabilityPolicy | null;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const isRepositoryPath = (value: unknown): value is string =>
	typeof value === "string" && value.trim() !== "" && value === value.trim() && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const paths = (value: unknown): ReadonlyArray<string> | null => Array.isArray(value) && value.length > 0 && value.every(isRepositoryPath) ? value : null;
const pattern = (value: unknown, captures: number): RegExp | null => {
	if (typeof value !== "string" || !value.trim()) return null;
	try {
		const compiled = new RegExp(value);
		const probe = new RegExp(compiled.source).exec("");
		// A static empty-string probe cannot establish all capture groups. Group count is
		// determined syntactically; escaped parentheses and character classes do not count.
		const count = (compiled.source.match(/(^|[^\\])\((?!\?)/g) ?? []).length;
		return count >= captures && probe !== undefined ? compiled : null;
	} catch { return null; }
};

/** Atomically parse the optional adapter section; no partial policy reaches a gate. */
export const parseFeatureReachabilityPolicy = (raw: unknown): FeatureReachabilityPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github)) return null;
	const optionalAdapters = raw.optionalAdapters;
	if (optionalAdapters === undefined) return {enabled: false};
	if (!isRecord(optionalAdapters)) return null;
	const adapter = optionalAdapters.featureReachability;
	if (adapter === undefined) return {enabled: false};
	if (!isRecord(adapter) || typeof adapter.enabled !== "boolean") return null;
	if (!adapter.enabled) return {enabled: false};
	const definitionsPath = adapter.definitionsPath;
	const consumerRoots = paths(adapter.consumerRoots);
	const journeyRoots = paths(adapter.journeyRoots);
	const consumerFilePattern = pattern(adapter.consumerFilePattern, 0);
	const journeyFilePattern = pattern(adapter.journeyFilePattern, 0);
	const definitionPattern = pattern(adapter.definitionPattern, 2);
	const journeyPattern = pattern(adapter.journeyPattern, 1);
	const exemptionPattern = pattern(adapter.exemptionPattern, 1);
	if (!isRepositoryPath(definitionsPath) || consumerRoots === null || journeyRoots === null || consumerFilePattern === null || journeyFilePattern === null || definitionPattern === null || journeyPattern === null || exemptionPattern === null) return null;
	return {enabled: true, definitionsPath, consumerRoots, consumerFilePattern, journeyRoots, journeyFilePattern, definitionPattern, journeyPattern, exemptionPattern};
};

/** Missing or malformed policy is untrusted; an absent adapter is a trusted disabled state. */
export const readFeatureReachabilityPolicy = (root: string): LoadedFeatureReachabilityPolicy => {
	const source = join(root, POLICY_PATH);
	if (!existsSync(source)) return {policy: null, trusted: false, source, reason: "agent policy could not be read"};
	try {
		const policy = parseFeatureReachabilityPolicy(JSON.parse(readFileSync(source, "utf8")) as unknown);
		return policy === null
			? {policy: null, trusted: false, source, reason: "feature-reachability policy has an unsupported shape"}
			: {policy, trusted: true, source, reason: null};
	} catch {
		return {policy: null, trusted: false, source, reason: "agent policy is not valid JSON"};
	}
};
