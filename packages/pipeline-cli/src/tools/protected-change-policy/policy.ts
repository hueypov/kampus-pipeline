import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

const POLICY_PATH = ".pipeline/agent-policy.json";

export type ProtectedChangePolicy = {readonly controlPlanePaths: ReadonlyArray<string>};

/** A policy document either yields a boundary or states why it is not one. */
export type ParsedProtectedChangePolicy =
	| {readonly policy: ProtectedChangePolicy; readonly reason: null}
	| {readonly policy: null; readonly reason: string};

const UNSAFE_SHAPE_REASON = "protected-change policy has an unsupported or unsafe shape";
const NO_BOUNDARY_REASON = "protected-change policy declares no protected paths; an empty controlPlanePaths is refused, never honoured as a boundary that protects nothing";

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

/**
 * Parse this independent boundary atomically; missing/malformed policy is not an empty boundary.
 * Neither is an empty list: honouring one would classify every path in every repository as
 * ordinary, so the §CP gate would pass without checking — and that is the state a repository is
 * left in by the shipped template, which declares no paths until the adopter names their own.
 * Refusing it here routes every consumer to its existing untrusted-policy fallback (#134).
 */
export const parseProtectedChangePolicy = (raw: unknown): ParsedProtectedChangePolicy => {
	if (!isRecord(raw) || raw.schemaVersion !== 1 || !isRecord(raw.github) || !isRecord(raw.github.shipping)) return {policy: null, reason: UNSAFE_SHAPE_REASON};
	const paths = validPatterns(raw.github.shipping.controlPlanePaths);
	if (paths === null) return {policy: null, reason: UNSAFE_SHAPE_REASON};
	return paths.length === 0 ? {policy: null, reason: NO_BOUNDARY_REASON} : {policy: {controlPlanePaths: paths}, reason: null};
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
		const parsed = parseProtectedChangePolicy(JSON.parse(source) as unknown);
		return parsed.policy === null
			? {policy: null, trusted: false, source: location, reason: parsed.reason}
			: {policy: parsed.policy, trusted: true, source: location, reason: null};
	} catch {
		return {policy: null, trusted: false, source: location, reason: "protected-change policy is not valid JSON"};
	}
};
