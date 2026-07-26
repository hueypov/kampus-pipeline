import {describe, expect, it} from "vitest";
import {consumedSymbolsIn, judge, parseFeatureDefinitions, parseJourneyKeys, renderReport} from "./reachability-guard.ts";

const definitionPattern = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*=\s*["']([a-z0-9-]+)["']/g;
const exemptionPattern = /@reachability-exempt:\s*(.+)/;
const journeyPattern = /@journey:([a-z0-9-]+)/g;

describe("reachability-guard pure core", () => {
	it("parses a repository-configured declaration shape and honors only an adjacent stated exemption", () => {
		const definitions = parseFeatureDefinitions(`
			/** A user-facing change. */
			export const BILLING_REDESIGN = "billing-redesign";
			/** An internal cache control. @reachability-exempt: no user-facing surface by design. */
			export const CACHE_TUNING = "cache-tuning";
		`, definitionPattern, exemptionPattern);
		expect(definitions).toEqual([
			{symbol: "BILLING_REDESIGN", featureKey: "billing-redesign", exemptReason: null},
			{symbol: "CACHE_TUNING", featureKey: "cache-tuning", exemptReason: "no user-facing surface by design."},
		]);
	});

	it("requires both configured evidence signals and reports each missing side", () => {
		const definitions = [{symbol: "BILLING_REDESIGN", featureKey: "billing-redesign", exemptReason: null}];
		const verdict = judge({featureKey: "billing-redesign", definitions, consumingSymbols: new Set(), journeyKeys: new Set()});
		expect(verdict).toMatchObject({pass: false, reason: "unreachable", missingConsumer: true, missingJourney: true});
		expect(renderReport(verdict)).toContain("MISSING CONSUMER");
		expect(renderReport(verdict)).toContain("MISSING JOURNEY");
	});

	it("fails closed on zero scope and an unknown feature instead of vacuously passing", () => {
		expect(judge({featureKey: "billing-redesign", definitions: [], consumingSymbols: new Set(), journeyKeys: new Set()})).toMatchObject({pass: false, reason: "zero-scope"});
		expect(judge({featureKey: "not-declared", definitions: [{symbol: "BILLING_REDESIGN", featureKey: "billing-redesign", exemptReason: null}], consumingSymbols: new Set(["BILLING_REDESIGN"]), journeyKeys: new Set(["billing-redesign"])})).toMatchObject({pass: false, reason: "unknown-feature"});
	});

	it("keeps consumer matching whole-word and extracts configured journey keys", () => {
		expect(consumedSymbolsIn("const BILLING_REDESIGN_PREVIEW = true", ["BILLING_REDESIGN"])).toEqual([]);
		expect(consumedSymbolsIn("useFeature(BILLING_REDESIGN)", ["BILLING_REDESIGN"])).toEqual(["BILLING_REDESIGN"]);
		expect(parseJourneyKeys('test("checkout @journey:billing-redesign", () => {})', journeyPattern)).toEqual(["billing-redesign"]);
	});
});
