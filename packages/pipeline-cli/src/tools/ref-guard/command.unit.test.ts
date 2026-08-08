import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {inspectHook, REFUSE_EXIT_CODE, renderManagedHook} from "./command.ts";

const tmpHook = (body: string): string => {
	const dir = mkdtempSync(join(tmpdir(), "ref-guard-hook-"));
	const path = join(dir, "reference-transaction");
	writeFileSync(path, body);
	return path;
};

const V1_HOOK = [
	"#!/bin/sh",
	"# kampus-pipeline ref-guard managed hook v1",
	"# Git only aborts a reference transaction for this command's deliberate refusal.",
	"status=0",
	'"/opt/node/bin/node" "/somewhere/else/packages/pipeline-cli/src/bin.ts" ref-guard reference-transaction "$1" || status=$?',
	'[ "$status" -eq 3 ] && exit 1',
	"exit 0",
	"",
].join("\n");

/** What an install from before the de-brand left on disk: today's v2 body, the retired marker. */
const legacyV2Hook = (recorded = "/recorded/at/install/bin.ts"): string =>
	renderManagedHook(recorded).replace(
		"# pipeline ref-guard managed hook v2",
		"# kampus-pipeline ref-guard managed hook v2",
	);

describe("ref-guard managed hook contract", () => {
	it("maps only the dedicated refusal to a Git-hook abort", () => {
		const hook = renderManagedHook();
		expect(hook).toContain(`[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1`);
		expect(hook).toContain("ref-guard reference-transaction");
	});

	it("resolves the toolkit and the interpreter at run time, not at install time", () => {
		const hook = renderManagedHook("/recorded/at/install/bin.ts");
		// v1 embedded process.execPath and the resolved bin.ts path and consulted nothing else, so
		// a repository that moved ran a hook pointing at where the toolkit used to be.
		expect(hook).toContain("git rev-parse --show-toplevel");
		expect(hook).toContain("command -v node");
	});

	it("consults the install-time path LAST — that ordering is the whole fix", () => {
		const hook = renderManagedHook("/recorded/at/install/bin.ts");
		const sub = hook.indexOf('"$root/.pipeline/toolkit/packages/pipeline-cli/src/bin.ts"');
		const own = hook.indexOf('"$root/packages/pipeline-cli/src/bin.ts"');
		const recorded = hook.indexOf('"/recorded/at/install/bin.ts"');
		// A moved repository finds its own toolkit and never reaches the stale path; a repository
		// whose toolkit genuinely lives elsewhere still resolves. v1 had only the last candidate.
		expect(sub).toBeGreaterThan(-1);
		expect(own).toBeGreaterThan(sub);
		expect(recorded).toBeGreaterThan(own);
	});

	it("says the guard is not running rather than failing silently, and does not abort git", () => {
		const hook = renderManagedHook();
		expect(hook).toContain("THE GUARD IS NOT RUNNING");
		// A reference-transaction hook that exits non-zero aborts the transaction. An unresolvable
		// toolkit must not brick every git operation in the repository.
		expect(hook).toMatch(/THE GUARD IS NOT RUNNING[\s\S]*?exit 0/);
	});

	it("distinguishes absent, installed, outdated, drifted, and foreign hooks", () => {
		const expected = renderManagedHook();
		expect(inspectHook("/this/path/does/not/exist", expected)).toBe("absent");
		expect(inspectHook(tmpHook(expected), expected)).toBe("installed");
		expect(inspectHook(tmpHook(V1_HOOK), expected)).toBe("outdated");
		expect(inspectHook(tmpHook("#!/bin/sh\necho someone elses hook\n"), expected)).toBe("foreign");
	});

	it("treats a hand-edited managed hook as drifted, not outdated", () => {
		const expected = renderManagedHook();
		const edited = `${expected}\n# someone added this by hand\n`;
		// It carries the current marker but is not a rendering we produced, so overwriting it would
		// discard an edit silently.
		expect(inspectHook(tmpHook(edited), expected)).toBe("drifted");
	});

	it("refuses a hand-edited V1 hook rather than upgrading over the edit", () => {
		const expected = renderManagedHook();
		const edited = V1_HOOK.replace("status=0", "status=0\n# local tweak: skip on CI\n[ -n \"$CI\" ] && exit 0");
		// Marker-substring matching called this `outdated` and install overwrote it silently —
		// exactly what the `drifted` refusal exists to prevent, and the reason the shape is
		// compared line by line instead.
		expect(inspectHook(tmpHook(edited), expected)).toBe("drifted");
	});

	it("still upgrades an untouched v1 hook whatever paths it baked", () => {
		const expected = renderManagedHook();
		const other = V1_HOOK.replace("/opt/node/bin/node", "/usr/local/bin/node").replace(
			"/somewhere/else/packages/pipeline-cli/src/bin.ts",
			"/another/place/bin.ts",
		);
		expect(inspectHook(tmpHook(other), expected)).toBe("outdated");
	});

	it("upgrades a v2 hook carrying the retired marker instead of disowning it", () => {
		const expected = renderManagedHook();
		// Every hook installed before the toolkit dropped its `kampus` names carries the old marker.
		// Reading those as `foreign` would refuse to touch them, stranding a stale guard in every
		// repository that adopted early — the one thing this rename must not do.
		expect(inspectHook(tmpHook(legacyV2Hook()), expected)).toBe("outdated");
	});

	it("refuses a hand-edited retired-marker hook rather than upgrading over the edit", () => {
		const expected = renderManagedHook();
		const edited = legacyV2Hook().replace("status=0", 'status=0\n# local tweak\n[ -n "$CI" ] && exit 0');
		// Recognising the retired marker must not weaken the drift refusal it travels with.
		expect(inspectHook(tmpHook(edited), expected)).toBe("drifted");
	});
});
