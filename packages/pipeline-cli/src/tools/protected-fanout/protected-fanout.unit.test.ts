import {describe, expect, it} from "vitest";
import {judgeProtectedFanout} from "./protected-fanout.ts";

const rules = [{id: "delivery-workflow", triggerPatterns: ["automation/"], companionPatterns: ["docs/automation.md"], requiredChecks: ["workflow-contract"], requiredRoles: ["delivery-owner"]}];

describe("protected fanout core", () => {
	it("reports every configured missing dependent obligation", () => {
		const verdict = judgeProtectedFanout(["automation/release.yml"], [], [], rules);
		expect(verdict).toMatchObject({pass: false, reason: "missing-obligations", missing: [{kind: "companion-path", expected: "docs/automation.md"}, {kind: "check", expected: "workflow-contract"}, {kind: "role", expected: "delivery-owner"}]});
	});

	it("passes only when all configured companion, check, and role obligations are present", () => {
		expect(judgeProtectedFanout(["automation/release.yml", "docs/automation.md"], ["workflow-contract"], ["delivery-owner"], rules)).toMatchObject({pass: true});
	});
});
