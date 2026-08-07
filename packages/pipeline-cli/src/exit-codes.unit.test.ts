/**
 * The shared exit table's own invariants. If these break, a caller's branch on an exit code starts
 * meaning something different without any verb having changed.
 */
import {describe, expect, it} from "@effect/vitest";
import * as Exit from "./exit-codes.ts";

describe("the shared exit table (#22)", () => {
	it("assigns every code exactly once", () => {
		// The defect this table exists to fix was three verbs each meaning something different by
		// `3`. A duplicate here would reintroduce it inside the fix.
		const codes = Exit.EXIT_TABLE.map((r) => r.code);
		expect(new Set(codes).size).toBe(codes.length);
	});

	it("reserves 0, 1 and 2 for the interface and allocates outcomes from 3 up", () => {
		expect([Exit.OK, Exit.FAILED, Exit.NO_IMPLEMENTATION]).toEqual([0, 1, 2]);
		const allocated = Exit.EXIT_TABLE.filter((r) => r.code > 2).map((r) => r.code);
		expect(Math.min(...allocated)).toBe(3);
	});

	it("keeps proven-absent separate from could-not-read", () => {
		expect(Exit.ZERO_SCOPE).not.toBe(Exit.PRECONDITION_UNKNOWN);
	});

	it("keeps a check that did not discriminate separate from one that matched nothing", () => {
		expect(Exit.INDETERMINATE).not.toBe(Exit.ZERO_SCOPE);
	});

	it("keeps an unconfirmed write separate from a plain failure and from a bad read-back", () => {
		expect(Exit.WRITE_UNKNOWN).not.toBe(Exit.FAILED);
		expect(Exit.WRITE_UNKNOWN).not.toBe(Exit.READBACK_MISMATCH);
	});

	it("keeps a reviewer's FAIL separate from a red build", () => {
		expect(Exit.GATE_FAIL).not.toBe(Exit.CHECKS_FAILED);
	});

	it("keeps pending separate from failing", () => {
		expect(Exit.NOT_YET).not.toBe(Exit.CHECKS_FAILED);
	});

	it("names every code in the table", () => {
		for (const row of Exit.EXIT_TABLE) expect(row.name).toMatch(/^[A-Z_]+$/);
	});
});
