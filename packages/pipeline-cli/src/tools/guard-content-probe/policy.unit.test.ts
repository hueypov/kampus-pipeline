import {describe, expect, it} from "vitest";
import {parseGuardContentPolicy} from "./policy.ts";

const policy = (guardContent: unknown) => ({schemaVersion: 1, github: {shipping: {guardContent}}});

describe("parseGuardContentPolicy", () => {
	it("accepts a fully configured enabled policy", () => {
		expect(parseGuardContentPolicy(policy({enabled: true, decisionRecordPaths: ["^records/"], vocabularyPatterns: ["safeguard"]}))).toEqual({
			enabled: true, decisionRecordPaths: ["^records/"], vocabularyPatterns: ["safeguard"],
		});
	});
	it("accepts only the explicit empty disabled policy", () => {
		expect(parseGuardContentPolicy(policy({enabled: false, decisionRecordPaths: [], vocabularyPatterns: []}))).toMatchObject({enabled: false});
		expect(parseGuardContentPolicy(policy({enabled: false, decisionRecordPaths: ["^records/"], vocabularyPatterns: []}))).toBeNull();
	});
	it("rejects incomplete, non-string, and invalid-regex configurations", () => {
		expect(parseGuardContentPolicy(policy({enabled: true, decisionRecordPaths: [], vocabularyPatterns: ["x"]}))).toBeNull();
		expect(parseGuardContentPolicy(policy({enabled: true, decisionRecordPaths: [1], vocabularyPatterns: ["x"]}))).toBeNull();
		expect(parseGuardContentPolicy(policy({enabled: true, decisionRecordPaths: ["("], vocabularyPatterns: ["x"]}))).toBeNull();
		expect(parseGuardContentPolicy(policy({enabled: true, decisionRecordPaths: ["x"], vocabularyPatterns: ["("]}))).toBeNull();
	});
});
