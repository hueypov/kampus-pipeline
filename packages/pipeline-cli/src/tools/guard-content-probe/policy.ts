import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {type GuardContentPolicy} from "./guard-content-probe.ts";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type LoadedGuardContentPolicy = {
	readonly policy: GuardContentPolicy | null;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const patterns = (value: unknown, allowEmpty: boolean): ReadonlyArray<string> | null =>
	Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => typeof entry === "string" && entry.trim() !== "")
		? value
		: null;

const validRegexes = (entries: ReadonlyArray<string>, flags = ""): boolean => {
	try {
		entries.forEach((entry) => new RegExp(entry, flags));
		return true;
	} catch {
		return false;
	}
};

/** Parse the complete additive guard-content section; never return a partly trusted policy. */
export const parseGuardContentPolicy = (raw: unknown): GuardContentPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.shipping)) return null;
	const guardContent = raw.github.shipping.guardContent;
	if (!isRecord(guardContent) || typeof guardContent.enabled !== "boolean") return null;
	const enabled = guardContent.enabled;
	const decisionRecordPaths = patterns(guardContent.decisionRecordPaths, !enabled);
	const vocabularyPatterns = patterns(guardContent.vocabularyPatterns, !enabled);
	if (decisionRecordPaths === null || vocabularyPatterns === null) return null;
	if (!enabled && (decisionRecordPaths.length !== 0 || vocabularyPatterns.length !== 0)) return null;
	if (enabled && (!validRegexes(decisionRecordPaths) || !validRegexes(vocabularyPatterns, "i"))) return null;
	return {enabled, decisionRecordPaths, vocabularyPatterns};
};

/** Resolve a Git root rather than treating an arbitrary parent as policy authority. */
export const repositoryRoot = (cwd = process.cwd()): string | null => {
	try {
		return execFileSync("git", ["rev-parse", "--show-toplevel"], {cwd, encoding: "utf8"}).trim() || null;
	} catch {
		return null;
	}
};

const sourceAtRef = (root: string, ref: string): string | null => {
	try {
		return execFileSync("git", ["show", `${ref}:${POLICY_PATH}`], {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
	} catch {
		return null;
	}
};

const sourceInWorktree = (root: string): string | null => {
	const path = join(root, POLICY_PATH);
	if (!existsSync(path)) return null;
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
};

/**
 * Read immutable policy when `policyRef` is supplied; a failed ref read never falls back to
 * the mutable worktree. Worktree reads are for local exploration only.
 */
export const readGuardContentPolicy = (root: string, policyRef: string | null): LoadedGuardContentPolicy => {
	const source = policyRef === null ? sourceInWorktree(root) : sourceAtRef(root, policyRef);
	const location = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	if (source === null) return {policy: null, trusted: false, source: location, reason: "guard-content policy could not be read"};
	try {
		const policy = parseGuardContentPolicy(JSON.parse(source) as unknown);
		return policy === null
			? {policy: null, trusted: false, source: location, reason: "guard-content policy has an unsupported or unsafe shape"}
			: {policy, trusted: true, source: location, reason: null};
	} catch {
		return {policy: null, trusted: false, source: location, reason: "guard-content policy is not valid JSON"};
	}
};
