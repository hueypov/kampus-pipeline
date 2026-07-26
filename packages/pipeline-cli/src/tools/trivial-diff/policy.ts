import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type TrivialDiffPolicy = {
	readonly enabled: boolean;
	readonly maxChangedLines: number;
	readonly protectedPaths: ReadonlyArray<string>;
};

export type LoadedTrivialDiffPolicy = {
	readonly policy: TrivialDiffPolicy | null;
	readonly trusted: boolean;
	readonly source: string;
	readonly reason: string | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const strings = (value: unknown): ReadonlyArray<string> | null =>
	Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim() !== "") ? value : null;

export const parseTrivialDiffPolicy = (raw: unknown): TrivialDiffPolicy | null => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.review)) return null;
	const trivialDiff = raw.github.review.trivialDiff;
	if (!isRecord(trivialDiff)) return null;
	const protectedPaths = strings(trivialDiff.protectedPaths);
	if (typeof trivialDiff.enabled !== "boolean" || !Number.isInteger(trivialDiff.maxChangedLines) || (trivialDiff.maxChangedLines as number) < 0 || protectedPaths === null) return null;
	try {
		protectedPaths.forEach((pattern) => new RegExp(pattern));
		return {enabled: trivialDiff.enabled, maxChangedLines: trivialDiff.maxChangedLines as number, protectedPaths};
	} catch {
		return null;
	}
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

/** Read immutable policy from a supplied ref; a failed ref read may never fall back to a PR worktree. */
export const readTrivialDiffPolicy = (root: string, policyRef: string | null): LoadedTrivialDiffPolicy => {
	const source = policyRef === null ? sourceInWorktree(root) : sourceAtRef(root, policyRef);
	const location = policyRef === null ? join(root, POLICY_PATH) : `${policyRef}:${POLICY_PATH}`;
	if (source === null) return {policy: null, trusted: false, source: location, reason: "trivial-diff policy could not be read"};
	try {
		const policy = parseTrivialDiffPolicy(JSON.parse(source) as unknown);
		return policy === null
			? {policy: null, trusted: false, source: location, reason: "trivial-diff policy has an unsupported or unsafe shape"}
			: {policy, trusted: true, source: location, reason: null};
	} catch {
		return {policy: null, trusted: false, source: location, reason: "trivial-diff policy is not valid JSON"};
	}
};
