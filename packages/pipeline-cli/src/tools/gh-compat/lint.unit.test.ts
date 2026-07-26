import {describe, expect, it} from "vitest";
import {lintCorpus, isZeroScope} from "./lint.ts";
import {DEFAULT_GH_COMPATIBILITY_POLICY, type GhCompatibilityPolicy} from "./policy.ts";

const policy: GhCompatibilityPolicy = {
	...DEFAULT_GH_COMPATIBILITY_POLICY,
	graphql: {...DEFAULT_GH_COMPATIBILITY_POLICY.graphql, mode: "rest-only", blockVerbs: ["project"]},
	skillLint: {...DEFAULT_GH_COMPATIBILITY_POLICY.skillLint, forbidConfiguredGraphqlPaths: true},
};

const validSkill = ["---", "name: sample", 'description: "valid: text"', "---", "", "use gh api repos/o/r/issues/1"].join("\n");

describe("lintCorpus", () => {
	it("reports configured gh-policy findings with line evidence", () => {
		const result = lintCorpus([{file: "skills/sample/SKILL.md", content: `${validSkill}\ngh project list\ngh api graphql -f query=x`}], policy);
		expect(result.findings).toHaveLength(2);
		expect(result.findings[0]).toMatchObject({matched: "gh project"});
		expect(result.findings[1]).toMatchObject({matched: "gh api graphql"});
		expect(isZeroScope(result, policy)).toBe(false);
	});

	it("keeps strict frontmatter validation independent from gh policy", () => {
		const broken = ["---", "name: sample", "description: broken: mapping", "---", "", "body"].join("\n");
		const result = lintCorpus([{file: "agents/reviewer.md", content: broken}], policy);
		expect(result.frontmatterFindings).toHaveLength(1);
	});

	it("fails closed when no required corpus scope was scanned", () => {
		const result = lintCorpus([{file: "notes.md", content: "plain prose"}], policy);
		expect(isZeroScope(result, policy)).toBe(true);
	});
});
