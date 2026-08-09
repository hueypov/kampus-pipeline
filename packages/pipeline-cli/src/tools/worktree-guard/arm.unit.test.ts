import {assert, describe, it} from "@effect/vitest";
import {formatArmStatus, isManagedWorktree, resolveArm} from "./arm.ts";

const WT = "/Users/dev/code/example-repo/.claude/worktrees/wf_abc123";
const OTHER_WT = "/Users/dev/code/example-repo/.claude/worktrees/wf_sidecar";

describe("isManagedWorktree", () => {
	it("recognizes the managed worktree layout", () => {
		assert.isTrue(isManagedWorktree(WT));
		assert.isFalse(isManagedWorktree("/some/bespoke/wt"));
		assert.isFalse(isManagedWorktree(""));
	});
});

describe("resolveArm — $WORKTREE_ROOT stays authoritative when it is present", () => {
	it("arms from the env root (source=env), ignoring the weaker signals", () => {
		const arm = resolveArm({envRoot: WT, sidecarWorktree: OTHER_WT, cwdWorktree: OTHER_WT});
		assert.strictEqual(arm.kind, "armed");
		if (arm.kind === "armed") {
			assert.strictEqual(arm.root, WT);
			assert.strictEqual(arm.source, "env");
		}
	});

	it("DISARMS on a bespoke (non-layout) env root, and says which layout it wanted", () => {
		const arm = resolveArm({
			envRoot: "/some/bespoke/wt",
			sidecarWorktree: "",
			cwdWorktree: "",
		});
		assert.strictEqual(arm.kind, "disarmed");
		if (arm.kind === "disarmed") assert.match(arm.reason, /not under the managed/);
	});
});

describe("resolveArm — the #141 fix: arming without $WORKTREE_ROOT", () => {
	it("arms from the agent meta sidecar when the harness omitted the env export", () => {
		const arm = resolveArm({envRoot: "", sidecarWorktree: WT, cwdWorktree: ""});
		assert.strictEqual(arm.kind, "armed");
		if (arm.kind === "armed") {
			assert.strictEqual(arm.root, WT);
			assert.strictEqual(arm.source, "sidecar");
		}
	});

	it("prefers the sidecar over the payload cwd (cwd resets; the sidecar does not)", () => {
		const arm = resolveArm({envRoot: "", sidecarWorktree: WT, cwdWorktree: OTHER_WT});
		assert.strictEqual(arm.kind, "armed");
		if (arm.kind === "armed") assert.strictEqual(arm.root, WT);
	});

	it("falls back to the payload cwd's linked worktree (source=git)", () => {
		const arm = resolveArm({envRoot: "", sidecarWorktree: "", cwdWorktree: WT});
		assert.strictEqual(arm.kind, "armed");
		if (arm.kind === "armed") assert.strictEqual(arm.source, "git");
	});

	it("ignores a sidecar/cwd path outside the managed layout", () => {
		const arm = resolveArm({
			envRoot: "",
			sidecarWorktree: "/some/bespoke/wt",
			cwdWorktree: "/Users/dev/code/example-repo",
		});
		assert.strictEqual(arm.kind, "disarmed");
	});
});

describe("resolveArm — no over-refusal for the orchestrator / a standalone run", () => {
	it("disarms (⇒ the cores allow) when no signal names a worktree at all", () => {
		const arm = resolveArm({envRoot: "", sidecarWorktree: "", cwdWorktree: ""});
		assert.strictEqual(arm.kind, "disarmed");
		if (arm.kind === "disarmed") assert.match(arm.reason, /standalone/);
	});
});

describe("formatArmStatus — armed-and-clean must not look like never-armed", () => {
	it("names the root and the signal it armed from", () => {
		const line = formatArmStatus({
			subcommand: "pre-bash",
			arm: {kind: "armed", root: WT, source: "sidecar"},
			isolationExpected: true,
		});
		assert.include(line, "ARMED");
		assert.notInclude(line, "NOT ARMED");
		assert.include(line, WT);
		assert.include(line, "source=sidecar");
	});

	it("says NOT ARMED with the reason, and flags the isolation-expected case as the dangerous one", () => {
		const line = formatArmStatus({
			subcommand: "pre-bash",
			arm: {kind: "disarmed", reason: "no signal"},
			isolationExpected: true,
		});
		assert.include(line, "NOT ARMED");
		assert.include(line, "isolation-expected=yes");
		assert.include(line, "no signal");
		assert.match(line, /head-move, stage-all/);
	});

	it("omits the surviving-refusal note when isolation was never expected", () => {
		const line = formatArmStatus({
			subcommand: "pre-file",
			arm: {kind: "disarmed", reason: "no signal"},
			isolationExpected: false,
		});
		assert.include(line, "isolation-expected=no");
		assert.notMatch(line, /head-move, stage-all/);
	});
});
