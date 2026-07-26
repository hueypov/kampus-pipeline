import {describe, expect, it} from "vitest";
import {classifyTrivialDiff} from "./trivial-diff.ts";
import {type GuardContentPolicy} from "../guard-content-probe/guard-content-probe.ts";

const oneLine = "diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new\n";
const ordinaryDecision = "diff --git a/records/1.md b/records/1.md\n--- a/records/1.md\n+++ b/records/1.md\n@@ -1 +1 @@\n-old\n+ordinary presentation choice\n";
const guardDecision = ordinaryDecision.replace("ordinary presentation choice", "We RELAX the safeguard");
const guardPolicy: GuardContentPolicy = {enabled: true, decisionRecordPaths: ["^records/.*\\.md$"], vocabularyPatterns: ["relax", "safeguard"]};
const disabledGuardPolicy: GuardContentPolicy = {enabled: false, decisionRecordPaths: [], vocabularyPatterns: []};

describe("classifyTrivialDiff", () => {
	it("accepts a small unprotected single-file text change", () => {
		expect(classifyTrivialDiff(oneLine, 2, [], disabledGuardPolicy).verdict).toBe("trivial");
	});
	it("fails closed for unparseable, multi-file, and protected diffs", () => {
		expect(classifyTrivialDiff("not a diff", 20, []).verdict).toBe("non-trivial");
		expect(classifyTrivialDiff(`${oneLine}${oneLine.replaceAll("readme.md", "code.ts")}`, 20, []).verdict).toBe("non-trivial");
		expect(classifyTrivialDiff(oneLine, 20, ["^readme\\.md$"]).verdict).toBe("non-trivial");
	});
	it("never marks binary or renamed content trivial", () => {
		expect(classifyTrivialDiff(`${oneLine}Binary files a/readme.md and b/readme.md differ`, 20, []).verdict).toBe("non-trivial");
		expect(classifyTrivialDiff(`${oneLine}rename from readme.md`, 20, []).verdict).toBe("non-trivial");
	});
	it("keeps configured guard-touching decision records out of lightweight review", () => {
		expect(classifyTrivialDiff(guardDecision, 20, [], guardPolicy)).toMatchObject({verdict: "non-trivial", reason: expect.stringContaining("guard-touching")});
		expect(classifyTrivialDiff(ordinaryDecision, 20, [], guardPolicy).verdict).toBe("trivial");
	});
	it("fails closed when the decision-record policy cannot be trusted", () => {
		expect(classifyTrivialDiff(oneLine, 20, [], null)).toMatchObject({verdict: "non-trivial", reason: expect.stringContaining("policy")});
	});
	it("treats deleted configured decision records as unreadable guard content", () => {
		const deleted = "diff --git a/records/1.md b/records/1.md\ndeleted file mode 100644\n--- a/records/1.md\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n";
		expect(classifyTrivialDiff(deleted, 20, [], guardPolicy)).toMatchObject({verdict: "non-trivial", reason: expect.stringContaining("unreadable-body")});
	});
});
