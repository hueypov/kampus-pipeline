/**
 * Pure staged-deletion classifier and decisions for the primary-index guard.
 *
 * This module deliberately knows no repository taxonomy.  The protected surface
 * is supplied by the adopter's policy, and all Git, filesystem, environment, and
 * process-exit behavior remains at the command boundary.
 */

export interface StagedEntry {
	readonly status: string;
	readonly path: string;
}

export interface PrimaryIndexAttributionPolicy {
	readonly enabled: boolean;
	readonly threshold: number;
	readonly logPath: string | null;
}

export interface PrimaryIndexGuardPolicy {
	readonly enabled: boolean;
	readonly protectedPathPrefixes: readonly string[];
	readonly blockThreshold: number;
	readonly attribution: PrimaryIndexAttributionPolicy;
}

export interface PrimaryIndexAttribution {
	readonly at: string;
	readonly onPrimaryCheckout: boolean;
	readonly cwd: string;
	readonly operator: string;
	readonly sessionId: string;
	readonly stagedDeletionCount: number;
	readonly protectedDeletionCount: number;
	readonly sampleProtectedDeletions: readonly string[];
}

export type PrimaryIndexCommitDecision =
	| {
			readonly kind: "allow";
			readonly reason: string;
			readonly stagedDeletionCount: number;
			readonly protectedDeletionCount: number;
			readonly sampleProtectedDeletions: readonly string[];
	  }
	| {
			readonly kind: "refuse";
			readonly reason: string;
			readonly record: PrimaryIndexAttribution;
	  };

export type PrimaryIndexRecordDecision =
	| {readonly kind: "quiet"; readonly reason: string}
	| {readonly kind: "record"; readonly record: PrimaryIndexAttribution};

export interface PrimaryIndexInput {
	/** False includes an indeterminate probe: only a proven primary checkout blocks. */
	readonly onPrimaryCheckout: boolean;
	readonly staged: readonly StagedEntry[];
	readonly policy: PrimaryIndexGuardPolicy;
	readonly cwd: string;
	readonly operator: string;
	readonly sessionId: string;
	readonly at: string;
}

const SAMPLE_SIZE = 8;

/**
 * Normalize a repository-relative policy prefix.  Normalization is intentionally
 * lexical: the guard must not traverse the filesystem while deciding a commit.
 */
export const normalizeProtectedPathPrefix = (value: string): string | null => {
	if (value === "" || value.trim() !== value || value.includes("\\") || value.includes("\0")) return null;
	if (value.startsWith("/") || value.startsWith("./") || value === ".") return null;
	const normalized = value.replace(/\/+$/, "");
	if (normalized === "" || normalized.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
	return normalized;
};

/** Boundary-aware matching: `config` matches `config/x`, never `configuration/x`. */
export const isProtectedPath = (path: string, prefixes: readonly string[]): boolean =>
	prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

/** Parse tab-separated output from `git diff --name-status`; malformed rows do not become paths. */
export const parseNameStatus = (raw: string): readonly StagedEntry[] =>
	raw
		.split("\n")
		.map((line) => {
			const tab = line.indexOf("\t");
			return tab < 0 ? null : {status: line.slice(0, tab), path: line.slice(tab + 1)};
		})
		.filter((entry): entry is StagedEntry => entry !== null && entry.path !== "");

export interface ProtectedDeletionSummary {
	readonly stagedDeletionCount: number;
	readonly protectedDeletionCount: number;
	readonly sampleProtectedDeletions: readonly string[];
}

/** A single reusable classifier for both observation and deliberate refusal. */
export const classifyProtectedDeletions = (
	staged: readonly StagedEntry[],
	protectedPathPrefixes: readonly string[],
): ProtectedDeletionSummary => {
	const deletions = staged.filter((entry) => entry.status.startsWith("D"));
	const protectedDeletions = deletions.filter((entry) => isProtectedPath(entry.path, protectedPathPrefixes));
	return {
		stagedDeletionCount: deletions.length,
		protectedDeletionCount: protectedDeletions.length,
		sampleProtectedDeletions: protectedDeletions.slice(0, SAMPLE_SIZE).map((entry) => entry.path),
	};
};

const attribution = (input: PrimaryIndexInput, summary: ProtectedDeletionSummary): PrimaryIndexAttribution => ({
	at: input.at,
	onPrimaryCheckout: input.onPrimaryCheckout,
	cwd: input.cwd,
	operator: input.operator,
	sessionId: input.sessionId,
	stagedDeletionCount: summary.stagedDeletionCount,
	protectedDeletionCount: summary.protectedDeletionCount,
	sampleProtectedDeletions: summary.sampleProtectedDeletions,
});

/**
 * Determine the hook outcome.  A refusal is possible only with an enabled
 * repository policy, a proven primary checkout, and count >= blockThreshold.
 */
export const decidePrimaryIndexCommit = (input: PrimaryIndexInput): PrimaryIndexCommitDecision => {
	const summary = classifyProtectedDeletions(input.staged, input.policy.protectedPathPrefixes);
	if (!input.policy.enabled) return {kind: "allow", reason: "primary-index guard policy is disabled", ...summary};
	if (!input.onPrimaryCheckout) {
		return {kind: "allow", reason: "primary checkout is not proven; allowing without a false refusal", ...summary};
	}
	if (summary.protectedDeletionCount < input.policy.blockThreshold) {
		return {
			kind: "allow",
			reason: `${summary.protectedDeletionCount} protected staged deletion(s) < block threshold ${input.policy.blockThreshold}`,
			...summary,
		};
	}
	return {
		kind: "refuse",
		reason:
			`${summary.protectedDeletionCount} protected staged deletion(s) meet block threshold ${input.policy.blockThreshold} on the shared primary checkout. ` +
			"Unstage or restore the deletion, or perform intentional broad removal from an isolated branch through the repository's review process.",
		record: attribution(input, summary),
	};
};

/** Observation never blocks: it applies the same classifier at its lower configured threshold. */
export const decidePrimaryIndexRecord = (input: PrimaryIndexInput): PrimaryIndexRecordDecision => {
	if (!input.policy.enabled || !input.policy.attribution.enabled) {
		return {kind: "quiet", reason: "primary-index attribution is disabled"};
	}
	const summary = classifyProtectedDeletions(input.staged, input.policy.protectedPathPrefixes);
	if (summary.protectedDeletionCount < input.policy.attribution.threshold) {
		return {
			kind: "quiet",
			reason: `${summary.protectedDeletionCount} protected staged deletion(s) < attribution threshold ${input.policy.attribution.threshold}`,
		};
	}
	return {kind: "record", record: attribution(input, summary)};
};
