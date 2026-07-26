import {describe, expect, it} from "vitest";
import {parseFeatureReachabilityPolicy} from "./policy.ts";

const enabled = {
	schemaVersion: 1,
	github: {},
	optionalAdapters: {
		featureReachability: {
			enabled: true,
			definitionsPath: "config/features.ts",
			consumerRoots: ["apps/client/src"],
			consumerFilePattern: "\\.tsx$",
			journeyRoots: ["tests/journeys"],
			journeyFilePattern: "\\.spec\\.ts$",
			definitionPattern: "export\\s+const\\s+([A-Z_]+)\\s*=\\s*[\\\"']([a-z0-9-]+)[\\\"']",
			journeyPattern: "@journey:([a-z0-9-]+)",
			exemptionPattern: "@reachability-exempt:\\s*(.+)",
		},
	},
};

describe("featureReachability policy", () => {
	it("is safely disabled when the optional section is absent", () => {
		expect(parseFeatureReachabilityPolicy({schemaVersion: 1, github: {}})).toEqual({enabled: false});
	});

	it("accepts a complete enabled repository-owned model", () => {
		const policy = parseFeatureReachabilityPolicy(enabled);
		expect(policy).toMatchObject({enabled: true, definitionsPath: "config/features.ts", consumerRoots: ["apps/client/src"], journeyRoots: ["tests/journeys"]});
	});

	it("rejects an enabled adapter that cannot prove its configured definition captures", () => {
		const malformed = structuredClone(enabled);
		malformed.optionalAdapters.featureReachability.definitionPattern = "export const ([A-Z_]+)";
		expect(parseFeatureReachabilityPolicy(malformed)).toBeNull();
	});
});
