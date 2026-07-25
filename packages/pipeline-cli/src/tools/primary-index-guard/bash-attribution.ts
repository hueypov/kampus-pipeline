import {isControlPlaneDeletion} from "./tripwire.ts";

export interface BashStagingInput {
	readonly command: string;
	readonly cwd: string;
	readonly onPrimaryCheckout: boolean;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly at: string;
}

export type BashStagingKind = "stage-all" | "rm-cached";

export interface BashStagingRecord {
	readonly at: string;
	readonly source: "pre-bash";
	readonly kind: BashStagingKind;
	readonly command: string;
	readonly cwd: string;
	readonly onPrimaryCheckout: boolean;
	readonly agentType: string;
	readonly sessionId: string;
	readonly worktreeRoot: string;
	readonly controlPlanePathArgs: readonly string[];
}

export type BashStagingDecision =
	| {readonly kind: "quiet"; readonly reason: string}
	| {readonly kind: "record"; readonly record: BashStagingRecord};

const segmentsOf = (command: string): readonly string[] => command.split(/&&|\|\||[;|]/);
const tokensOf = (segment: string): readonly string[] =>
	segment.trim().split(/\s+/).filter((token) => token !== "");
const isAddAllPathspec = (token: string): boolean =>
	token === "." ||
	token === "--all" ||
	token === "--no-ignore-removal" ||
	(/^-[A-Za-z]*$/.test(token) && token.includes("A"));
const isCommitAllFlag = (token: string): boolean =>
	token === "--all" || (/^-[a-z]*$/.test(token) && token.includes("a"));

const subcommandStart = (tokens: readonly string[], gitIndex: number): number => {
	let index = gitIndex + 1;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "-C" || token === "--git-dir" || token === "--work-tree" || token === "-c") {
			index += 2;
			continue;
		}
		if (/^(--git-dir|--work-tree)=/.test(token) || token.startsWith("-")) {
			index += 1;
			continue;
		}
		break;
	}
	return index;
};

const dequote = (value: string): string => value.replace(/^["']/, "").replace(/["']$/, "");
const stripTrailingSlashes = (value: string): string => {
	let end = value.length;
	while (end > 0 && value[end - 1] === "/") end--;
	return value.slice(0, end);
};
const controlPlanePathArgs = (rest: readonly string[]): string[] =>
	rest
		.filter((token) => !token.startsWith("-"))
		.map(dequote)
		.filter((token) => isControlPlaneDeletion(`${stripTrailingSlashes(token)}/`) || isControlPlaneDeletion(token));

const classifySegment = (segment: string): {kind: BashStagingKind; paths: string[]} | null => {
	const tokens = tokensOf(segment);
	const gitIndex = tokens.indexOf("git");
	if (gitIndex < 0) return null;
	const index = subcommandStart(tokens, gitIndex);
	const subcommand = tokens[index] ?? "";
	const rest = tokens.slice(index + 1);
	if (subcommand === "add" && rest.some(isAddAllPathspec)) return {kind: "stage-all", paths: []};
	if (subcommand === "commit" && rest.some(isCommitAllFlag)) return {kind: "stage-all", paths: []};
	if (subcommand === "rm" && rest.includes("--cached")) {
		return {kind: "rm-cached", paths: controlPlanePathArgs(rest)};
	}
	return null;
};

export const decideBashStagingAttribution = (input: BashStagingInput): BashStagingDecision => {
	for (const segment of segmentsOf(input.command)) {
		const hit = classifySegment(segment);
		if (hit === null) continue;
		return {
			kind: "record",
			record: {
				at: input.at,
				source: "pre-bash",
				kind: hit.kind,
				command: input.command,
				cwd: input.cwd,
				onPrimaryCheckout: input.onPrimaryCheckout,
				agentType: input.agentType,
				sessionId: input.sessionId,
				worktreeRoot: input.worktreeRoot,
				controlPlanePathArgs: hit.paths,
			},
		};
	}
	return {kind: "quiet", reason: "no bulk-staging op (stage-all / rm --cached) in the command"};
};

export const renderBashStagingNote = (record: BashStagingRecord): string =>
	`primary-index-tripwire pre-bash ATTRIBUTION (#2778): a ${record.kind} git op on ` +
	`${record.onPrimaryCheckout ? "the PRIMARY checkout" : "a linked worktree"} — ` +
	`agent=${record.agentType || "unset"} session=${record.sessionId || "unset"} cwd=${record.cwd} ` +
	`worktree-root=${record.worktreeRoot || "unset"}${record.controlPlanePathArgs.length > 0 ? ` · control-plane args: ${record.controlPlanePathArgs.join(", ")}` : ""} · command: ${record.command}`;
