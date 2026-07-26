import {describe, expect, it} from "vitest";
import {classifyPaths, FAIL_CLOSED_POLICY, type ClassificationPolicy} from "./class-probe.ts";

const policy: ClassificationPolicy = {
	code: {includePatterns: ["^(src|packages|scripts)/"], excludePatterns: []},
	docs: {includePatterns: ["^(docs|\\.decisions)/|\\.md$"], excludePatterns: ["^skills/"]},
	skills: {includePatterns: ["^(skills|agents)/"], excludePatterns: []},
	design: {includePatterns: ["^src/ui/"], excludePatterns: ["\\.(test|spec)\\.[jt]sx?$"]},
};

describe("classifyPaths", () => {
	it("fans across every matching class in stable order and keeps design additive", () => {
		expect(classifyPaths(["skills/review/SKILL.md", "src/ui/Panel.tsx", "docs/guide.md"], policy)).toMatchObject({
			classes: ["has-code", "has-docs", "has-skills", "has-design"],
			namespaces: ["review-code", "review-doc", "review-skill", "review-design"],
		});
	});

	it("uses carve-then-test exclusions for docs and design", () => {
		expect(classifyPaths(["skills/review/SKILL.md"], policy).classes).toEqual(["has-skills"]);
		expect(classifyPaths(["src/ui/Panel.test.tsx"], policy).namespaces).toEqual(["review-code"]);
	});

	it("routes a real unclassified file to review-code and leaves an empty diff ungated", () => {
		expect(classifyPaths(["tooling.config"], policy).namespaces).toEqual(["review-code"]);
		expect(classifyPaths([], policy).namespaces).toEqual([]);
	});

	it("over-dispatches every namespace when a policy pattern is invalid", () => {
		const broken: ClassificationPolicy = {...policy, docs: {includePatterns: ["["], excludePatterns: []}};
		expect(classifyPaths(["ordinary.txt"], broken)).toMatchObject({trusted: false, namespaces: ["review-code", "review-doc", "review-skill", "review-design"]});
	});

	it("keeps missing-policy behavior conservative without gating an empty diff", () => {
		expect(classifyPaths(["ordinary.txt"], FAIL_CLOSED_POLICY).namespaces).toEqual(["review-code", "review-doc", "review-skill", "review-design"]);
		expect(classifyPaths([], FAIL_CLOSED_POLICY).namespaces).toEqual([]);
	});
});
