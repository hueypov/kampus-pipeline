import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import type {OwnershipRule, OwnershipSource} from "./protected-ownership.ts";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type ProtectedOwnershipPolicy =
	| {readonly enabled: false}
	| {readonly enabled: true; readonly enforcement: "advisory" | "blocking"; readonly source: OwnershipSource; readonly sourcePath: string | null; readonly ownerPattern: RegExp; readonly rules: ReadonlyArray<OwnershipRule>};

export type LoadedProtectedOwnershipPolicy = {readonly policy: ProtectedOwnershipPolicy | null; readonly trusted: boolean; readonly source: string; readonly reason: string | null};

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const repositoryPath = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const regex = (value: unknown): RegExp | null => { try { return typeof value === "string" && value.trim() ? new RegExp(value) : null; } catch { return null; } };
const ownerRules = (value: unknown, ownerPattern: RegExp): ReadonlyArray<OwnershipRule> | null => {
	if (!Array.isArray(value)) return null;
	const rules: OwnershipRule[] = [];
	for (const item of value) {
		if (!isRecord(item) || !repositoryPath(item.pattern) || !Array.isArray(item.owners) || item.owners.length === 0 || !item.owners.every((owner) => typeof owner === "string" && ownerPattern.test(owner))) return null;
		rules.push({pattern: item.pattern, owners: item.owners as string[]});
	}
	return rules;
};

/** Parse atomically: absence is disabled; an enabled adapter never receives partial configuration. */
export const parseProtectedOwnershipPolicy = (raw: unknown): ProtectedOwnershipPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github)) return null;
	if (raw.optionalAdapters === undefined) return {enabled: false};
	if (!isRecord(raw.optionalAdapters) || raw.optionalAdapters.protectedOwnership === undefined) return {enabled: false};
	const adapter = raw.optionalAdapters.protectedOwnership;
	if (!isRecord(adapter) || typeof adapter.enabled !== "boolean") return null;
	if (!adapter.enabled) return {enabled: false};
	if ((adapter.enforcement !== "advisory" && adapter.enforcement !== "blocking") || (adapter.source !== "static" && adapter.source !== "codeowners")) return null;
	const ownerPattern = regex(adapter.ownerPattern);
	if (ownerPattern === null) return null;
	const rules = ownerRules(adapter.rules, ownerPattern);
	if (rules === null) return null;
	if (adapter.source === "static" && (adapter.sourcePath !== null || rules.length === 0)) return null;
	if (adapter.source === "codeowners" && (!repositoryPath(adapter.sourcePath) || rules.length !== 0)) return null;
	const source: OwnershipSource = adapter.source;
	const enforcement: "advisory" | "blocking" = adapter.enforcement;
	return {enabled: true, enforcement, source, sourcePath: source === "codeowners" ? adapter.sourcePath as string : null, ownerPattern, rules};
};

export const repositoryRoot = (cwd = process.cwd()): string | null => { try { return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null; } catch { return null; } };
const textAtRef = (root: string, ref: string): string | null => { try { return execFileSync("git", ["show", `${ref}:${POLICY_PATH}`], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}); } catch { return null; } };
const textInWorktree = (root: string): string | null => { const path = join(root, POLICY_PATH); try { return existsSync(path) ? readFileSync(path, "utf8") : null; } catch { return null; } };

export const readProtectedOwnershipPolicy = (root: string, policyRef: string | null): LoadedProtectedOwnershipPolicy => {
	const contents = policyRef === null ? textInWorktree(root) : textAtRef(root, policyRef);
	const source = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	if (contents === null) return {policy: null, trusted: false, source, reason: "agent policy could not be read"};
	try {
		const policy = parseProtectedOwnershipPolicy(JSON.parse(contents) as unknown);
		return policy === null ? {policy: null, trusted: false, source, reason: "protected-ownership policy has an unsupported or unsafe shape"} : {policy, trusted: true, source, reason: null};
	} catch { return {policy: null, trusted: false, source, reason: "agent policy is not valid JSON"}; }
};
