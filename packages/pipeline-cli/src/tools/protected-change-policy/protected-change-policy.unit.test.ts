import {describe, expect, it} from "vitest";
import {classifyProtectedChanges, renderProtectedChangeRegex} from "./protected-change-policy.ts";

describe("protected-change policy core", () => {
	it("classifies only repository-configured protected paths", () => {
		expect(classifyProtectedChanges([".github/workflows/test.yml", "docs/readme.md"], ["^\\.github/", "^pipeline/"])).toMatchObject({
			protectedPaths: [".github/workflows/test.yml"], ordinaryPaths: ["docs/readme.md"], trusted: true,
		});
	});

	it("never converts an invalid pattern into an empty protected boundary", () => {
		expect(classifyProtectedChanges(["ordinary.md"], ["["])).toMatchObject({protectedPaths: ["ordinary.md"], trusted: false});
	});

	it("renders one anchored POSIX ERE from configured paths and no hidden default", () => {
		expect(renderProtectedChangeRegex(["^\\.github/", "^pipeline/(skills|agents)/"])).toBe("^((\\.github/)|(pipeline/(skills|agents)/))");
		expect(renderProtectedChangeRegex([])).toBe("^$");
	});
});
