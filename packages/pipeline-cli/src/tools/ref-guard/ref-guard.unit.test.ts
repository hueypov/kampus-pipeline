import {describe, expect, it} from "vitest";
import {type CheckoutContext, type ComparisonFacts, decideHeadDetach, decideRefUpdate, decideTransaction, HEAD_REF, type RefUpdate, ZERO_OID} from "./ref-guard.ts";

const OID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const guarded = "refs/heads/trunk";
const update = (over: Partial<RefUpdate> = {}): RefUpdate => ({oldOid: OID_A, newOid: OID_B, refName: guarded, ...over});
const facts = (over: Partial<ComparisonFacts> = {}): ComparisonFacts => ({comparisonOid: null, comparisonIsAncestorOfNew: false, currentOid: null, packedOid: null, ...over});
const detach = (over: Partial<CheckoutContext> = {}): CheckoutContext => ({sharedHeadPending: null, operationInProgress: false, ...over});

describe("ref-guard pure decisions", () => {
	it("allows off-primary updates and a proven primary fast-forward", () => {
		expect(decideRefUpdate(update({refName: "refs/heads/feature"}), guarded, facts({comparisonOid: OID_A})).kind).toBe("allow");
		expect(decideRefUpdate(update(), guarded, facts({comparisonOid: OID_A, comparisonIsAncestorOfNew: true})).kind).toBe("allow");
	});

	it("refuses primary deletes and divergence but allows a missing comparison ref", () => {
		expect(decideRefUpdate(update({newOid: ZERO_OID}), guarded, facts()).kind).toBe("refuse");
		// A real deletion also removes any packed copy, and Git reports THAT as its own transaction
		// with no old value to match — so a packed ref does not excuse it.
		expect(decideRefUpdate(update({oldOid: ZERO_OID, newOid: ZERO_OID}), guarded, facts({packedOid: OID_A})).kind).toBe("refuse");
		// A packed copy at a DIFFERENT value than the caller asserted is not this ref's survival.
		expect(decideRefUpdate(update({oldOid: OID_A, newOid: ZERO_OID}), guarded, facts({packedOid: OID_B})).kind).toBe("refuse");
		expect(decideRefUpdate(update(), guarded, facts({comparisonOid: OID_A})).kind).toBe("refuse");
		expect(decideRefUpdate(update(), guarded, facts()).kind).toBe("allow");
	});

	it("allows a same-value write of a merely-behind primary", () => {
		// git stash push / reset --hard HEAD re-write the branch at its current oid. With origin
		// ahead (comparison not an ancestor of new), the write moves nothing and must pass — the
		// standstill is not a rewrite, and refusing it aborts the stash that precedes a catch-up pull.
		expect(decideRefUpdate(update({newOid: OID_A}), guarded, facts({comparisonOid: OID_B})).kind).toBe("allow");
	});

	it("allows a standstill whose old value arrived zero-filled", () => {
		// `git pack-refs` (so `git gc`, so the `gc --auto` in commit/fetch/merge/pull) migrates a loose
		// ref into packed-refs as `0000…0 <current> <ref>`. The caller asserts no old value, so the
		// same-value test above cannot fire, and a merely-BEHIND primary then reads the standstill as
		// a rewrite one rung down and aborts the whole pack-refs run.
		expect(decideRefUpdate(update({oldOid: ZERO_OID, newOid: OID_A}), guarded, facts({comparisonOid: OID_B, currentOid: OID_A})).kind).toBe("allow");
		// A ref that really is moving stays on the strict ancestry path.
		expect(decideRefUpdate(update({oldOid: ZERO_OID, newOid: OID_B}), guarded, facts({comparisonOid: OID_A, currentOid: OID_A})).kind).toBe("refuse");
	});

	it("allows pack-refs pruning the loose copy of a ref that survives packed", () => {
		// The other half of a pack-refs run: `<current> 0000…0 <ref>`, the loose copy dropped now that
		// packed-refs holds the same value. Indistinguishable on stdin from `git update-ref -d <ref>
		// <oid>`, so the packed value is what separates them — and a real delete removes that too.
		expect(decideRefUpdate(update({oldOid: OID_A, newOid: ZERO_OID}), guarded, facts({packedOid: OID_A})).kind).toBe("allow");
	});

	it("refuses only an unpaired concrete HEAD move on the primary", () => {
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}], detach({sharedHeadPending: OID_B})).kind).toBe("refuse");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}, update()], detach({sharedHeadPending: OID_B})).kind).toBe("allow");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: "ref:refs/heads/trunk", refName: HEAD_REF}], detach({sharedHeadPending: OID_B})).kind).toBe("allow");
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}], detach()).kind).toBe("allow");
	});

	it("scopes the rung to the HEAD under transaction, not to the checkout that invoked git", () => {
		// `git worktree add --detach` from the primary sends a bare-oid HEAD line from the primary's
		// own context; only the ref store Git locked says the write lands on the new worktree's HEAD.
		expect(decideHeadDetach([{oldOid: ZERO_OID, newOid: OID_B, refName: HEAD_REF}], detach()).kind).toBe("allow");
		// A same-value bare write still detaches an attached primary — `update-ref --no-deref HEAD
		// <oid> <oid>` reports the resolved oid as its old value — so it stays refused.
		expect(decideHeadDetach([{oldOid: OID_B, newOid: OID_B, refName: HEAD_REF}], detach({sharedHeadPending: OID_B})).kind).toBe("refuse");
	});

	it("ignores shared-HEAD evidence staged for somebody else's transaction", () => {
		// A concurrent `commit`/`reset --hard`/`stash` in the primary holds the shared HEAD lock while
		// this hook runs. Reading the value Git staged there — rather than merely observing the lock —
		// is what keeps that from refusing an unrelated worktree add all over again, intermittently.
		expect(decideHeadDetach([{oldOid: ZERO_OID, newOid: OID_B, refName: HEAD_REF}], detach({sharedHeadPending: OID_A})).kind).toBe("allow");
	});

	it("allows the transient detach Git drives during rebase and bisect", () => {
		// `git rebase` detaches the shared HEAD onto the upstream tip and reattaches it in the same
		// command; refusing it also stranded the operator in a half-started `.git/rebase-merge`.
		expect(decideHeadDetach([{oldOid: OID_A, newOid: OID_B, refName: HEAD_REF}], detach({sharedHeadPending: OID_B, operationInProgress: true})).kind).toBe("allow");
	});

	it("makes a transaction all-or-nothing", () => {
		expect(decideTransaction([{kind: "allow", reason: "ok"}, {kind: "refuse", reason: "stop"}])).toEqual({kind: "refuse", reason: "stop"});
	});
});
