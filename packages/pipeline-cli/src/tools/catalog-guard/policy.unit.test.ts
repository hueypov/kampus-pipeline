import {describe, expect, it} from "vitest";
import {parseCatalogPolicy} from "./policy.ts";

const policy = (catalogGuard: unknown) => ({schemaVersion: 1, workflows: {}, adapters: {catalogGuard}});
const disabled = {enabled: false, packageManager: null, workspaceManifest: null, packageGlobs: [], dependencyFields: [], catalogNames: [], allowedSpecifierPrefixes: [], allowlist: []};
const enabled = {enabled: true, packageManager: "pnpm-catalog", workspaceManifest: "pnpm-workspace.yaml", packageGlobs: [".", "packages/*"], dependencyFields: ["dependencies", "devDependencies"], catalogNames: ["tooling"], allowedSpecifierPrefixes: ["catalog:", "workspace:"], allowlist: []};

describe("catalog-guard optional policy", () => {
	it("accepts only the explicit empty disabled policy", () => {
		expect(parseCatalogPolicy(policy(disabled))).toMatchObject({enabled: false, packageManager: null});
		expect(parseCatalogPolicy(policy({...disabled, packageGlobs: ["packages/*"]}))).toBeNull();
	});
	it("accepts a fully specified enabled pnpm catalog policy", () => {
		expect(parseCatalogPolicy(policy(enabled))).toMatchObject({enabled: true, packageManager: "pnpm-catalog", workspaceManifest: "pnpm-workspace.yaml"});
	});
	it("rejects incomplete, unsafe, or non-pnpm enabled settings", () => {
		expect(parseCatalogPolicy(policy({...enabled, packageManager: "npm"}))).toBeNull();
		expect(parseCatalogPolicy(policy({...enabled, workspaceManifest: "../outside.yaml"}))).toBeNull();
		expect(parseCatalogPolicy(policy({...enabled, allowedSpecifierPrefixes: ["catalog"]}))).toBeNull();
		expect(parseCatalogPolicy(policy({...enabled, allowlist: [{name: "x", reason: ""}]}))).toBeNull();
	});
});
