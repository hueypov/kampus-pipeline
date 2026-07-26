import type {Classification} from "./trivial-diff.ts";

export type ReviewRoute = "review-trivial" | "full-review";

export type TrivialDiffRouteInput = {
	/** The explicit, immutable repository enablement. */
	readonly enabled: boolean;
	/** The fail-closed small-diff classification. */
	readonly classifier: Classification | null;
	/** The complete result from the shared changed-path classifier. */
	readonly namespaces: ReadonlyArray<string>;
	readonly namespacesTrusted: boolean;
	/** `unknown` represents absent/unreadable protected-boundary policy. */
	readonly protectedChange: "protected" | "ordinary" | "unknown";
	/** A configured decision-record candidate is retained on the full path conservatively. */
	readonly hasGuardContentCandidate: boolean;
	/** The invoking workflow must prove it can obtain the same SHA-bound verdict contract. */
	readonly reducedGateSupported: boolean;
};

export type TrivialDiffRouteDecision = {readonly route: ReviewRoute; readonly reason: string};

const full = (reason: string): TrivialDiffRouteDecision => ({route: "full-review", reason});

const KNOWN_SINGLE_NAMESPACES = new Set(["review-code", "review-doc", "review-skill", "review-design"]);

/**
 * The only positive route is a deliberately enabled, fully trusted, ordinary single-surface
 * diff which the caller can submit to the SHA-bound reduced gate. Every other state retains
 * the complete review fan-out.
 */
export const selectTrivialDiffRoute = (input: TrivialDiffRouteInput): TrivialDiffRouteDecision => {
	if (!input.enabled) return full("trivial review is disabled or policy is unavailable");
	if (!input.reducedGateSupported) return full("the invoking workflow cannot prove reduced-gate SHA-bound verdict support");
	if (input.classifier === null || input.classifier.verdict !== "trivial") return full(input.classifier?.reason ?? "trivial-diff classifier result is unavailable");
	if (!input.namespacesTrusted) return full("changed-path classification policy is unavailable or invalid");
	if (input.namespaces.length !== 1 || !KNOWN_SINGLE_NAMESPACES.has(input.namespaces[0] ?? "")) return full("diff is mixed, empty, or has an unexpected review namespace");
	if (input.protectedChange !== "ordinary") return full(input.protectedChange === "unknown" ? "protected-change boundary is unavailable" : "diff contains a configured protected path");
	if (input.hasGuardContentCandidate) return full("diff contains a configured safeguard decision-record candidate");
	return {route: "review-trivial", reason: `enabled ordinary ${input.namespaces[0]} diff passed every lightweight-review precondition`};
};
