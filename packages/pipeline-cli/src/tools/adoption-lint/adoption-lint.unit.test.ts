import {describe, expect, it} from "vitest";
import {isZeroScope, lintAdoption} from "./adoption-lint.ts";

const decision = {
	id: "issue-create", authority: "pipeline-cli tracker create", signature: [/POST \/issues/, /title=/], evidence: [/pipeline-cli tracker create/], reason: "the shared creator owns this envelope",
};

describe("adoption-lint generic governance core", () => {
	it("reports a governed claim with its authority and missing evidence", () => {
		const result = lintAdoption([{file: "skills/example/SKILL.md", content: "POST /issues title=Example"}], [decision], []);
		expect(result.findings).toEqual([expect.objectContaining({file: "skills/example/SKILL.md", decision: "issue-create", authority: "pipeline-cli tracker create", missingEvidence: ["pipeline-cli tracker create"]})]);
	});
	it("accepts the same claim when configured evidence is present", () => {
		const result = lintAdoption([{file: "skills/example/SKILL.md", content: "POST /issues title=Example; use pipeline-cli tracker create"}], [decision], []);
		expect(result.findings).toEqual([]);
	});
	it("self-lints stale exemptions and refuses zero scope", () => {
		const result = lintAdoption([{file: "skills/example/SKILL.md", content: "use pipeline-cli tracker create"}], [decision], [{kind: "grandfathered", path: "skills/example/SKILL.md", decision: "issue-create", reason: "temporary migration"}]);
		expect(result.exemptionFindings).toHaveLength(1);
		expect(isZeroScope(lintAdoption([], [decision], []))).toBe(true);
	});
	it("does not permit a documentation file to be a runtime mirror", () => {
		const result = lintAdoption([{file: "guidance.md", content: "POST /issues title=Example"}], [decision], [{kind: "mirror", path: "guidance.md", reason: "not a valid mirror"}]);
		expect(result.exemptionFindings).toHaveLength(1);
	});
});
