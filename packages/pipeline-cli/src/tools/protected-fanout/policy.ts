import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {FanoutRule} from "./protected-fanout.ts";

const POLICY_PATH = ".pipeline/agent-policy.json";
export type ProtectedFanoutPolicy = {readonly enabled: false} | {readonly enabled: true; readonly enforcement: "advisory" | "blocking"; readonly rules: ReadonlyArray<FanoutRule>};
export type LoadedProtectedFanoutPolicy = {readonly policy: ProtectedFanoutPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const strings = (value: unknown): ReadonlyArray<string> | null => Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim() !== "") ? value : null;
const pattern = (value: string): boolean => !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const rules = (value: unknown): ReadonlyArray<FanoutRule> | null => {
	if (!Array.isArray(value) || value.length === 0) return null;
	const out: FanoutRule[] = [];
	for (const item of value) {
		if (!record(item) || typeof item.id !== "string" || !item.id.trim()) return null;
		const triggerPatterns = strings(item.triggerPatterns); const companionPatterns = strings(item.companionPatterns); const requiredChecks = strings(item.requiredChecks); const requiredRoles = strings(item.requiredRoles);
		if (triggerPatterns === null || triggerPatterns.length === 0 || companionPatterns === null || requiredChecks === null || requiredRoles === null || triggerPatterns.some((item) => !pattern(item)) || companionPatterns.some((item) => !pattern(item)) || (companionPatterns.length + requiredChecks.length + requiredRoles.length === 0)) return null;
		out.push({id: item.id, triggerPatterns, companionPatterns, requiredChecks, requiredRoles});
	}
	return new Set(out.map((item) => item.id)).size === out.length ? out : null;
};
export const parseProtectedFanoutPolicy = (raw: unknown): ProtectedFanoutPolicy | null => {
	if (!record(raw) || raw.schemaVersion !== 1 || !record(raw.github)) return null;
	if (raw.optionalAdapters === undefined) return {enabled: false};
	if (!record(raw.optionalAdapters) || raw.optionalAdapters.protectedFanout === undefined) return {enabled: false};
	const adapter = raw.optionalAdapters.protectedFanout;
	if (!record(adapter) || typeof adapter.enabled !== "boolean") return null;
	if (!adapter.enabled) return {enabled: false};
	if ((adapter.enforcement !== "advisory" && adapter.enforcement !== "blocking")) return null;
	const configuredRules = rules(adapter.rules);
	return configuredRules === null ? null : {enabled: true, enforcement: adapter.enforcement, rules: configuredRules};
};
export const repositoryRoot = (cwd = process.cwd()): string | null => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; } };
const atRef = (root: string, ref: string): string | null => { try { return execFileSync("git", ["show", `${ref}:${POLICY_PATH}`], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}); } catch { return null; } };
export const readProtectedFanoutPolicy = (root: string, policyRef: string | null): LoadedProtectedFanoutPolicy => {
	const source = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	let text: string | null;
	try { text = policyRef === null ? (existsSync(source) ? readFileSync(source, "utf8") : null) : atRef(root, policyRef); } catch { text = null; }
	if (text === null) return {policy: null, trusted: false, source, reason: "agent policy could not be read"};
	try { const policy = parseProtectedFanoutPolicy(JSON.parse(text) as unknown); return policy === null ? {policy: null, trusted: false, source, reason: "protected-fanout policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null}; } catch { return {policy: null, trusted: false, source, reason: "agent policy is not valid JSON"}; }
};
