import {describe, expect, it} from "vitest";
import {decideHeadDetach, decideRefUpdate, decideTransaction, HEAD_REF, type RefUpdate, ZERO_OID} from "./ref-guard.ts";

const OID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const guarded = "refs/heads/trunk";
const update = (over: Partial<RefUpdate> = {}): RefUpdate => ({oldOid: OID_A, newOid: OID_B, refName: guarded, ...over});

describe("ref-guard pure decisions", () => {
	it("allows off-primary updates and a proven primary fast-forward", () => {
		expect(decideRefUpdate(update({refName: "refs/heads/feature"}), guarded, {comparisonOid: OID_A, comparisonIsAncestorOfNew: false}).kind).toBe("allow");
		expect(decideRefUpdate(update(), guarded, {comparisonOid: OID_A, comparisonIsAncestorOfNew: true}).kind).toBe("allow");
	});

	it("refuses primary deletes and divergence but allows a missing comparison ref", () => {
		expect(decideRefUpdate(update({newOid: ZERO_OID}), guarded, {comparisonOid: null, comparisonIsAncestorOfNew: false}).kind).toBe("refuse");
		expect(decideRefUpdate(update(), guarded, {comparisonOid: OID_A, comparisonIsAncestorOfNew: false}).kind).toBe("refuse");
		expect(decideRefUpdate(update(), guarded, {comparisonOid: null, comparisonIsAncestorOfNew: false}).kind).toBe("allow");
	});

	it("allows a same-value write of a merely-behind primary", () => {
		// git stash push / reset --hard HEAD re-write the branch at its current oid. With origin
		// ahead (comparison not an ancestor of new), the write moves nothing and must pass — the
		// standstill is not a rewrite, and refusing it aborts the stash that precedes a catch-up pull.
		expect(decideRefUpdate(update({newOid: OID_A}), guarded, {comparisonOid: OID_B, comparisonIsAncestorOfNew: false}).kind).toBe("allow");
	});

	it("refuses only an unpaired concrete HEAD move on the primary", () => {
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}], {isPrimaryCheckout: true}).kind).toBe("refuse");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}, update()], {isPrimaryCheckout: true}).kind).toBe("allow");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: "ref:refs/heads/trunk", refName: HEAD_REF}], {isPrimaryCheckout: true}).kind).toBe("allow");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}], {isPrimaryCheckout: false}).kind).toBe("allow");
	});

	it("makes a transaction all-or-nothing", () => {
		expect(decideTransaction([{kind: "allow", reason: "ok"}, {kind: "refuse", reason: "stop"}])).toEqual({kind: "refuse", reason: "stop"});
	});
});
