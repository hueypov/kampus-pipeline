import {describe, expect, it} from "vitest";
import {inspectHook, REFUSE_EXIT_CODE, renderManagedHook} from "./command.ts";

describe("ref-guard managed hook contract", () => {
	it("maps only the dedicated refusal to a Git-hook abort", () => {
		const hook = renderManagedHook("/toolkit/packages/pipeline-cli/src/bin.ts");
		expect(hook).toContain(`[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1`);
		expect(hook).toContain("ref-guard reference-transaction");
	});

	it("distinguishes absent, managed, drifted, and foreign hooks", () => {
		const expected = renderManagedHook();
		expect(inspectHook("/this/path/does/not/exist", expected)).toBe("absent");
	});
});
