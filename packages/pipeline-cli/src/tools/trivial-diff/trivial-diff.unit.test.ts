import {describe, expect, it} from "vitest";
import {classifyTrivialDiff} from "./trivial-diff.ts";

const oneLine = "diff --git a/readme.md b/readme.md\n--- a/readme.md\n+++ b/readme.md\n@@ -1 +1 @@\n-old\n+new\n";

describe("classifyTrivialDiff", () => {
	it("accepts a small unprotected single-file text change", () => {
		expect(classifyTrivialDiff(oneLine, 2, []).verdict).toBe("trivial");
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
});
