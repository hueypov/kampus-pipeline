import {describe, expect, it} from "vitest";
import {classifyOwnership, parseCodeowners, verifyOwnership} from "./protected-ownership.ts";

describe("protected ownership core", () => {
	it("uses only a supplied CODEOWNERS source and its final matching rule", () => {
		const rules = parseCodeowners("/protected/ @team-a\n/protected/release.yml @release\n");
		const classified = classifyOwnership(["protected/release.yml", "docs/readme.md"], rules, "codeowners");
		expect(classified).toMatchObject({kind: "affected", affected: [{path: "protected/release.yml", owners: ["@release"]}], ordinaryPaths: ["docs/readme.md"]});
		expect(verifyOwnership(classified, ["@release"]).pass).toBe(true);
	});

	it("fails closed rather than merging overlapping static owner mappings", () => {
		expect(classifyOwnership(["protected/release.yml"], [{pattern: "protected/", owners: ["a"]}, {pattern: "protected/*.yml", owners: ["b"]}], "static")).toMatchObject({kind: "indeterminate", reason: "ambiguous-rules"});
	});
});
