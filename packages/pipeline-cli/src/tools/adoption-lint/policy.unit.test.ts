import {describe, expect, it} from "vitest";
import {parseAdoptionPolicy} from "./policy.ts";

const policy = (adoptionLint: unknown) => ({schemaVersion: 1, workflows: {}, adapters: {adoptionLint}});
const disabled = {enabled: false, corpusGlobs: [], decisions: [], exemptions: []};
const enabled = {enabled: true, corpusGlobs: ["skills/**/*.md"], decisions: [{id: "shared-contract", authority: "repository-owned command", signaturePatterns: ["first tell", "second tell"], evidencePatterns: ["repository-owned command"], reason: "avoid a divergent copy"}], exemptions: []};

describe("adoption-lint optional policy", () => {
	it("accepts only the explicit empty disabled policy", () => {
		expect(parseAdoptionPolicy(policy(disabled))).toMatchObject({enabled: false});
		expect(parseAdoptionPolicy(policy({...disabled, corpusGlobs: ["skills/**/*.md"]}))).toBeNull();
	});
	it("accepts a configured corpus and governed concept", () => {
		expect(parseAdoptionPolicy(policy(enabled))).toMatchObject({enabled: true, corpusGlobs: ["skills/**/*.md"]});
	});
	it("rejects incomplete patterns and exemptions for an unknown concept", () => {
		expect(parseAdoptionPolicy(policy({...enabled, decisions: [{...enabled.decisions[0], evidencePatterns: ["("]}]}))).toBeNull();
		expect(parseAdoptionPolicy(policy({...enabled, exemptions: [{kind: "grandfathered", path: "skills/old.md", decision: "unknown", reason: "migration"}]}))).toBeNull();
	});
});
