import {assert, describe, it} from "@effect/vitest";
import {Effect} from "effect";
import type * as Schema from "effect/Schema";
import {cleanMapBody} from "./fixtures.ts";
import {decodeMapLedger} from "./github.ts";
import {isValidMap, validateMap} from "./validate.ts";

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect);

describe("decodeMapLedger — the GitHub boundary", () => {
	it("decodes a map issue + sub-issues into a valid ledger", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				subIssues: [
					{number: 101, state: "open"},
					{number: 102, state: "open"},
					{number: 103, state: "open"},
					{number: 104, state: "open"},
				],
			}),
		);
		assert.strictEqual(ledger.number, 100);
		assert.deepStrictEqual(
			ledger.subIssues.map((s) => s.number),
			[101, 102, 103, 104],
		);
		assert.strictEqual(ledger.map.openFrontier.entries.length, 2);
		assert.strictEqual(isValidMap(ledger), true);
	});

	it("sub-issue state survives the boundary and reaches the floor", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				subIssues: [
					{number: 101, state: "closed", state_reason: "completed"},
					{number: 102, state: "closed", state_reason: "completed"},
					{number: 103, state: "closed", state_reason: "completed"},
					{number: 104, state: "open"},
				],
			}),
		);
		assert.strictEqual(ledger.subIssues.find((s) => s.number === 103)?.state, "closed");
		// #103 is on the open frontier, so the floor reconciles it as drift.
		const defect = validateMap(ledger).find((d) => d.type === "CLOSED_FRONTIER_TICKET");
		assert.deepStrictEqual(defect?.refs, [103]);
	});

	it("a missing or unrecognized state decodes as unresolved, not as a failure", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				subIssues: [
					{number: 101},
					{number: 102, state: null},
					{number: 103, state: "archived"},
					{number: 104, state: "open"},
				],
			}),
		);
		assert.deepStrictEqual(
			ledger.subIssues.map((s) => s.state),
			[undefined, undefined, undefined, "open"],
		);
		assert.strictEqual(isValidMap(ledger), true);
	});

	it("a null body decodes to four absent sections (all MISSING_*)", async () => {
		const ledger = await run(decodeMapLedger({map: {number: 5, body: null}, subIssues: []}));
		assert.strictEqual(ledger.map.destination.present, false);
		assert.strictEqual(validateMap(ledger).length, 4);
	});

	it("a frontier ref absent from the sub-issue set dangles", async () => {
		const ledger = await run(
			decodeMapLedger({
				map: {number: 100, body: cleanMapBody},
				// the originating work item is dropped from the real sub-issues — its frontier ref must dangle.
				subIssues: [
					{number: 101, state: "open"},
					{number: 102, state: "open"},
					{number: 103, state: "open"},
				],
			}),
		);
		assert.include(
			validateMap(ledger).map((d) => d.type),
			"DANGLING_FRONTIER_REF",
		);
	});

	it("fails with SchemaError on structurally malformed JSON (missing number)", async () => {
		const exit = await Effect.runPromiseExit(decodeMapLedger({map: {body: "x"}, subIssues: []}));
		assert.strictEqual(exit._tag, "Failure");
	});

	it("SchemaError is the decode error channel", () => {
		// The decode's error channel is exactly Schema.SchemaError — a compile-time
		// pin that the boundary never leaks an untyped throw.
		const _pin: (u: unknown) => Effect.Effect<unknown, Schema.SchemaError> = decodeMapLedger;
		assert.isFunction(_pin);
	});
});
