import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type ProtectedChangePolicy = {readonly controlPlanePaths: ReadonlyArray<string>};

export type LoadedProtectedChangePolicy = {
	readonly policy: ProtectedChangePolicy | null;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const validPatterns = (value: unknown): ReadonlyArray<string> | null => {
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string" && entry.trim() !== "" && entry.startsWith("^"))) return null;
	if (new Set(value).size !== value.length) return null;
	try {
		value.forEach((entry) => new RegExp(entry));
		return value;
	} catch {
		return null;
	}
};

/** Parse this independent boundary atomically; missing/malformed policy is not an empty boundary. */
export const parseProtectedChangePolicy = (raw: unknown): ProtectedChangePolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.shipping)) return null;
	const paths = validPatterns(raw.github.shipping.controlPlanePaths);
	return paths === null ? null : {controlPlanePaths: paths};
};

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

/** A supplied policy ref is immutable authority; a failed ref read never falls back to the worktree. */
export const readProtectedChangePolicy = (root: string, policyRef: string | null): LoadedProtectedChangePolicy => {
	const source = policyRef === null ? sourceInWorktree(root) : sourceAtRef(root, policyRef);
	const location = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	if (source === null) return {policy: null, trusted: false, source: location, reason: "protected-change policy could not be read"};
	try {
		const policy = parseProtectedChangePolicy(JSON.parse(source) as unknown);
		return policy === null
			? {policy: null, trusted: false, source: location, reason: "protected-change policy has an unsupported or unsafe shape"}
			: {policy, trusted: true, source: location, reason: null};
	} catch {
		return {policy: null, trusted: false, source: location, reason: "protected-change policy is not valid JSON"};
	}
};
