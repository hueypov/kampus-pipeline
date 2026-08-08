import {assert, describe, it} from "@effect/vitest";
import {identityCheck, type IdentityInput} from "./identity.ts";

const check = (over: Partial<IdentityInput>) =>
	identityCheck({pr: 47, authenticated: "nothueypov", author: "hueypov", asserted: null, ...over});

describe("identityCheck — the firewall decides over a READ identity, not a declared one (#53)", () => {
	it("permits a reviewer who is not the author", () => {
		assert.isNull(check({}));
	});

	it("refuses when the authenticated account IS the author, with no --as in sight", () => {
		// The whole defect: every documented invocation omits --as, so this is the case that used to
		// sail through. Measured live before the fix — exit 1 at the marker check, not exit 10 here.
		const refusal = check({authenticated: "hueypov"});
		assert.strictEqual(refusal?._tag, "self-verdict");
		assert.include(refusal?.message ?? "", "hueypov");
		assert.include(refusal?.message ?? "", "may not post a verdict on their own work");
	});

	it("names BOTH identities in the self-verdict refusal", () => {
		// A refusal that says only "this identity" leaves the reader to guess which account `gh` is
		// on — the exact confusion that produced the incident.
		const message = check({authenticated: "Hueypov", author: "hueypov"})?.message ?? "";
		assert.include(message, "authored by hueypov");
		assert.include(message, "authenticated as Hueypov");
	});

	it("refuses the incident exactly: authenticated as the author, --as naming someone else", () => {
		// PR #47's second verdict comment. `--as nothueypov` satisfied the old check because it was
		// compared to the author string rather than to the caller.
		const refusal = check({authenticated: "hueypov", asserted: "nothueypov"});
		assert.strictEqual(refusal?._tag, "asserted-mismatch");
		assert.include(refusal?.message ?? "", "--as nothueypov");
		assert.include(refusal?.message ?? "", "authenticated account hueypov");
	});

	it("reports the false --as ahead of the self-verdict, because it names the cause", () => {
		// Both hold in the incident. Reporting only "you authored this" sends a caller that believes
		// it switched accounts looking in the wrong place.
		assert.strictEqual(check({authenticated: "hueypov", asserted: "nothueypov"})?._tag, "asserted-mismatch");
	});

	it("refuses a --as that disagrees even when the poster is NOT the author", () => {
		// Not merely a self-verdict guard: a verdict is attributed to the logged-in account, so a
		// mismatch means the record will not say what the caller thinks it says.
		assert.strictEqual(check({asserted: "someone-else"})?._tag, "asserted-mismatch");
	});

	it("accepts a --as that agrees, case-insensitively", () => {
		assert.isNull(check({authenticated: "nothueypov", asserted: "NotHueypov"}));
	});

	it("treats a truthful --as as no weaker than omitting it", () => {
		assert.strictEqual(check({authenticated: "hueypov", asserted: "hueypov"})?._tag, "self-verdict");
	});

	const unresolved: ReadonlyArray<{readonly name: string; readonly over: Partial<IdentityInput>}> = [
		{name: "the authenticated account could not be read", over: {authenticated: ""}},
		{name: "the PR's author could not be read", over: {author: ""}},
		{name: "--as was passed an empty value", over: {asserted: ""}},
		{name: "--as was passed only whitespace", over: {asserted: "   "}},
	];
	for (const {name, over} of unresolved) {
		it(`fails closed as unresolved when ${name}`, () => {
			assert.strictEqual(check(over)?._tag, "unresolved");
		});
	}

	it("never lets two unreadable identities read as two different people", () => {
		// "" === "" would be a match, but the empty string is not an identity. Deciding unreadability
		// first is what keeps an all-reads-failed run from looking like a clean second-party review.
		assert.strictEqual(check({authenticated: "", author: ""})?._tag, "unresolved");
	});

	it("compares identities case- and whitespace-insensitively", () => {
		assert.strictEqual(check({authenticated: " HUEYPOV ", author: "hueypov"})?._tag, "self-verdict");
	});
});
