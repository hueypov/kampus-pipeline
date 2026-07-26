import {describe, expect, it} from "vitest";
import {classifyGuardContent, selectGuardContentCandidates, type GuardContentPolicy} from "./guard-content-probe.ts";

const policy: GuardContentPolicy = {
	enabled: true,
	decisionRecordPaths: ["^records/.*\\.md$"],
	vocabularyPatterns: ["safeguard", "relax"],
};

describe("guard-content-probe core", () => {
	it("selects configured candidates in input order and removes duplicates", () => {
		expect(selectGuardContentCandidates(["src/a.ts", "records/a.md", "records/a.md", "records/b.md"], policy)).toEqual({
			paths: ["records/a.md", "records/b.md"], trusted: true, reason: null,
		});
	});
	it("selects every changed path when policy cannot be trusted and none when explicitly disabled", () => {
		expect(selectGuardContentCandidates(["a", "a", "b"], null).paths).toEqual(["a", "b"]);
		expect(selectGuardContentCandidates(["a", "b"], {...policy, vocabularyPatterns: ["("]}).paths).toEqual(["a", "b"]);
		expect(selectGuardContentCandidates(["records/a.md"], {...policy, enabled: false, decisionRecordPaths: [], vocabularyPatterns: []}).paths).toEqual([]);
	});
	it("matches vocabulary case-insensitively and leaves readable ordinary content ordinary", () => {
		expect(classifyGuardContent("This RELAXES a safeguard.", policy)).toMatchObject({decision: "guard-touching", reason: "guard-vocabulary-match"});
		expect(classifyGuardContent("A routine presentation choice.", policy)).toMatchObject({decision: "not-guard-touching", reason: "no-match"});
	});
	it("fails closed for absent body, invalid patterns, disabled policy, and untrusted policy", () => {
		expect(classifyGuardContent("", policy).decision).toBe("guard-touching");
		expect(classifyGuardContent(null, policy).reason).toBe("unreadable-body");
		expect(classifyGuardContent("ordinary", {...policy, vocabularyPatterns: ["("]}).reason).toBe("invalid-vocabulary-pattern");
		expect(classifyGuardContent("ordinary", {...policy, enabled: false, decisionRecordPaths: [], vocabularyPatterns: []}).reason).toBe("guard-content-disabled");
		expect(classifyGuardContent("ordinary", null).reason).toBe("untrusted-policy");
	});
});
