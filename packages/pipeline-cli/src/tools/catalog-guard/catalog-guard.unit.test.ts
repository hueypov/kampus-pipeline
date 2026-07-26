import {describe, expect, it} from "vitest";
import {judge, manifestDeps} from "./catalog-guard.ts";

const rule = {allowedSpecifierPrefixes: ["catalog:", "workspace:"], catalogNames: ["tooling"], allowlist: []};

describe("catalog-guard generic core", () => {
	it("accepts configured catalog forms and internal workspace references", () => {
		expect(judge([{path: "package.json", deps: [
			{field: "dependencies", name: "a", value: "catalog:"},
			{field: "devDependencies", name: "b", value: "catalog:tooling"},
			{field: "dependencies", name: "c", value: "workspace:*"},
		]}], rule)).toMatchObject({pass: true});
	});

	it("rejects unconfigured named catalogs and hardcoded declarations", () => {
		const verdict = judge([{path: "packages/a/package.json", deps: [
			{field: "dependencies", name: "a", value: "catalog:unconfigured"},
			{field: "dependencies", name: "b", value: "^1.0.0"},
		]}], rule);
		expect(verdict).toMatchObject({pass: false, reason: "nonconforming-declarations"});
		if (!verdict.pass && verdict.reason === "nonconforming-declarations") expect(verdict.violations).toHaveLength(2);
	});

	it("fails closed on zero manifest scope and respects narrow reasoned exceptions", () => {
		expect(judge([], rule)).toEqual({pass: false, reason: "zero-scope"});
		expect(judge([{path: "package.json", deps: [{field: "dependencies", name: "external", value: "file:../external"}]}], {
		...rule, allowlist: [{name: "external", path: "package.json", reason: "repository-owned exception"}],
	})).toMatchObject({pass: true});
	});

	it("extracts only policy-selected dependency fields", () => {
		expect(manifestDeps({dependencies: {one: "catalog:"}, optionalDependencies: {two: "^1"}}, ["dependencies"])).toEqual([
		{field: "dependencies", name: "one", value: "catalog:"},
	]);
	});
});
