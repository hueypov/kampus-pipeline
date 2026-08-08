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

/**
 * v2 verbatim, as this tool shipped it. Transcribed rather than re-rendered on purpose: it is the
 * body real installs carry, so if v3's upgrade path stops recognising it, this is what says so.
 */
const V2_HOOK = [
	"#!/bin/sh",
	"# kampus-pipeline ref-guard managed hook v2",
	"# Git only aborts a reference transaction for this command's deliberate refusal.",
	"# The toolkit and interpreter are resolved at run time — see ref-guard/command.ts.",
	"status=0",
	'root=$(git rev-parse --show-toplevel 2>/dev/null) || root=""',
	'bin=""',
	"for candidate in \\",
	'  "$root/.pipeline/toolkit/packages/pipeline-cli/src/bin.ts" \\',
	'  "$root/packages/pipeline-cli/src/bin.ts" \\',
	'  "/recorded/at/install/bin.ts"',
	"do",
	'  if [ -f "$candidate" ]; then bin="$candidate"; break; fi',
	"done",
	'if [ -z "$bin" ]; then',
	`  echo "ref-guard: no toolkit under '$root' and none at the recorded path — THE GUARD IS NOT RUNNING; re-run pipeline init" >&2`,
	"  exit 0",
	"fi",
	'node_bin=$(command -v node 2>/dev/null) || node_bin=""',
	'if [ -z "$node_bin" ]; then',
	'  echo "ref-guard: no node on PATH — THE GUARD IS NOT RUNNING" >&2',
	"  exit 0",
	"fi",
	'"$node_bin" "$bin" ref-guard reference-transaction "$1" || status=$?',
	'[ "$status" -eq 3 ] && exit 1',
	"exit 0",
	"",
].join("\n");

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

	it("tries a candidate rather than choosing one, so an uninstalled copy cannot silence the guard", () => {
		const hook = renderManagedHook("/recorded/at/install/bin.ts");
		// The bug (#85): `[ -f ]` selected a bin.ts whose dependencies were absent, which then died
		// at module load — and every non-refusal status read as "ran, no refusal", so the guard was
		// off behind a stack trace. Only the CLI's own two verdicts may end the search.
		expect(hook).toContain('[ -f "$candidate" ] || continue');
		expect(hook).toContain(`[ "$status" -eq ${REFUSE_EXIT_CODE} ] && exit 1`);
		expect(hook).toContain('[ "$status" -eq 0 ] && exit 0');
		// Git delivers the updates on stdin; a first attempt that drained them would leave the next
		// candidate judging an empty transaction.
		expect(hook).toContain("updates=$(cat)");
		expect(hook).toMatch(/printf '%s\\n' "\$updates" \| "\$node_bin" "\$candidate"/);
	});

	it("distinguishes absent, installed, outdated, drifted, and foreign hooks", () => {
		const expected = renderManagedHook();
		expect(inspectHook("/this/path/does/not/exist", expected)).toBe("absent");
		expect(inspectHook(tmpHook(expected), expected)).toBe("installed");
		expect(inspectHook(tmpHook(V1_HOOK), expected)).toBe("outdated");
		// Every real install carries v2; if it stopped reading as ours, `install` would refuse it as
		// hand-edited and nobody would ever receive the fix.
		expect(inspectHook(tmpHook(V2_HOOK), expected)).toBe("outdated");
		expect(inspectHook(tmpHook("#!/bin/sh\necho someone elses hook\n"), expected)).toBe("foreign");
	});

	it("recognises its own rendering with a different recorded path, rather than calling it drifted", () => {
		// v1 and v2 both shipped without a shape for themselves, so a re-install from a different
		// toolkit location — a moved checkout, a version-stamped store directory — read as
		// hand-edited and had to be deleted by hand. Carrying the current shape fixes that as it
		// happens instead of one version later.
		const expected = renderManagedHook();
		expect(inspectHook(tmpHook(renderManagedHook("/somewhere/else/bin.ts")), expected)).toBe("outdated");
	});

	it("skips a candidate an earlier one already resolved to", () => {
		// `.pipeline/toolkit` is a symlink to the repository root when the toolkit hosts itself, so
		// the first two candidates are the same file — and a worktree without an install would pay
		// two identical crashing Node starts before reaching one that works.
		const hook = renderManagedHook("/recorded/at/install/bin.ts");
		expect(hook).toContain('case "$tried" in *"|$real|"*) continue ;; esac');
		expect(hook).toContain('real="$dir/$(basename -- "$candidate")"');
	});

	it("treats a hand-edited v2 hook as drifted, not outdated", () => {
		const expected = renderManagedHook();
		const edited = V2_HOOK.replace('  if [ -f "$candidate" ]; then bin="$candidate"; break; fi', "  bin=$candidate");
		expect(inspectHook(tmpHook(edited), expected)).toBe("drifted");
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
});
