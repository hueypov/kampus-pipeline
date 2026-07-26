import {describe, expect, it} from "vitest";
import {decideMainSync} from "./main-sync.ts";

describe("decideMainSync", () => {
	it("refuses when no primary branch can be proved", () => {
		expect(decideMainSync({primaryBranch: null, currentBranch: "feature", trackedChanges: false})).toMatchObject({kind: "refuse"});
	});
	it("refuses a dirty checkout before any reattach", () => {
		expect(decideMainSync({primaryBranch: "trunk", currentBranch: null, trackedChanges: true})).toMatchObject({kind: "refuse"});
	});
	it("uses the shared primary-index classifier outcome before its broad dirty-check refusal", () => {
		expect(decideMainSync({
		primaryBranch: "trunk",
		currentBranch: "trunk",
		trackedChanges: true,
		protectedStagedDeletionCount: 25,
		protectedStagedDeletionThreshold: 25,
	})).toMatchObject({kind: "refuse", reason: expect.stringContaining("primary-index guard threshold")});
	});
	it("allows a clean detached checkout to reattach", () => {
		expect(decideMainSync({primaryBranch: "trunk", currentBranch: null, trackedChanges: false})).toEqual({kind: "sync", checkoutPrimary: true});
	});
});
