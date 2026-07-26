import {describe, expect, it} from "vitest";
import {selectTrivialDiffRoute, type TrivialDiffRouteInput} from "./route.ts";

const positive: TrivialDiffRouteInput = {
	enabled: true,
	classifier: {verdict: "trivial", reason: "proved"},
	namespaces: ["review-doc"],
	namespacesTrusted: true,
	protectedChange: "ordinary",
	hasGuardContentCandidate: false,
	reducedGateSupported: true,
};

describe("selectTrivialDiffRoute", () => {
	it("selects review-trivial only for the complete positive conjunction", () => {
		expect(selectTrivialDiffRoute(positive)).toMatchObject({route: "review-trivial"});
	});

	it.each([
		["disabled", {enabled: false}],
		["missing reduced-gate contract", {reducedGateSupported: false}],
		["unavailable classifier", {classifier: null}],
		["non-trivial classifier", {classifier: {verdict: "non-trivial", reason: "binary"}}],
		["untrusted namespaces", {namespacesTrusted: false}],
		["mixed namespaces", {namespaces: ["review-code", "review-doc"]}],
		["unexpected namespace", {namespaces: ["other"]}],
		["protected path", {protectedChange: "protected"}],
		["unknown protected policy", {protectedChange: "unknown"}],
		["guard candidate", {hasGuardContentCandidate: true}],
	] as const)("keeps %s on the full review path", (_name, overrides) => {
		expect(selectTrivialDiffRoute({...positive, ...overrides})).toMatchObject({route: "full-review"});
	});
});
