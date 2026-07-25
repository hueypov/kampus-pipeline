import {appendFileSync} from "node:fs";
import {resolve} from "node:path";

export interface StagedEntry {
	readonly status: string;
	readonly path: string;
}

export const CONTROL_PLANE_DELETION_PREFIXES: readonly string[] = [
	".claude/",
	".decisions/",
	".github/",
	".glossary/",
	".patterns/",
	"claude-plugins/",
];

export const isControlPlaneDeletion = (path: string): boolean =>
	CONTROL_PLANE_DELETION_PREFIXES.some((prefix) => path.startsWith(prefix));

export const MASS_DELETION_BLOCK_THRESHOLD = 25;

export interface TripwireInput {
	readonly onPrimaryCheckout: boolean;
	readonly staged: readonly StagedEntry[];
	readonly cwd: string;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly threshold: number;
	readonly at: string;
}

export interface AttributionRecord {
	readonly at: string;
	readonly onPrimaryCheckout: boolean;
	readonly cwd: string;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly stagedDeletionCount: number;
	readonly controlPlaneDeletionCount: number;
	readonly sampleControlPlaneDeletions: readonly string[];
}

export type TripwireDecision =
	| {readonly kind: "quiet"; readonly reason: string}
	| {readonly kind: "trip"; readonly record: AttributionRecord};

const SAMPLE_SIZE = 8;

export const decideTripwire = (input: TripwireInput): TripwireDecision => {
	const deletions = input.staged.filter((entry) => entry.status.startsWith("D"));
	const controlPlane = deletions.filter((entry) => isControlPlaneDeletion(entry.path));
	if (controlPlane.length < input.threshold) {
		return {
			kind: "quiet",
			reason: `${controlPlane.length} control-plane staged deletion(s) < threshold ${input.threshold}`,
		};
	}
	return {
		kind: "trip",
		record: {
			at: input.at,
			onPrimaryCheckout: input.onPrimaryCheckout,
			cwd: input.cwd,
			agentType: input.agentType,
			sessionId: input.sessionId,
			worktreeRoot: input.worktreeRoot,
			stagedDeletionCount: deletions.length,
			controlPlaneDeletionCount: controlPlane.length,
			sampleControlPlaneDeletions: controlPlane.slice(0, SAMPLE_SIZE).map((entry) => entry.path),
		},
	};
};

export const parseNameStatus = (raw: string): readonly StagedEntry[] =>
	raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.map((line) => {
			const tab = line.indexOf("\t");
			if (tab < 0) return {status: line, path: ""};
			return {status: line.slice(0, tab), path: line.slice(tab + 1)};
		})
		.filter((entry) => entry.path !== "");

export const renderWarning = (record: AttributionRecord): string =>
	`primary-index-tripwire TRIP (#2778): ${record.controlPlaneDeletionCount} control-plane staged deletion(s) ` +
	`(${record.stagedDeletionCount} total) about to be committed on ` +
	`${record.onPrimaryCheckout ? "the PRIMARY checkout" : "a linked worktree"} — ` +
	`agent=${record.agentType || "unset"} session=${record.sessionId || "unset"} cwd=${record.cwd} ` +
	`worktree-root=${record.worktreeRoot || "unset"} · sample: ${record.sampleControlPlaneDeletions.join(", ")}`;

export const appendRecord = (logPath: string, line: string): void => {
	try {
		appendFileSync(logPath, line);
	} catch {
		// Attribution is best effort and must never perturb the guarded operation.
	}
};

export const defaultLogPath = (): string =>
	process.env.PRIMARY_INDEX_TRIPWIRE_LOG ??
	resolve(process.env.TMPDIR ?? "/tmp", "primary-index-tripwire.jsonl");
