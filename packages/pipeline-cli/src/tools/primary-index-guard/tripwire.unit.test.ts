import {describe, expect, it} from "@effect/vitest";
import {
	decideBashStagingAttribution,
	renderBashStagingNote,
	type BashStagingInput,
} from "./bash-attribution.ts";

const input = (command: string, over: Partial<BashStagingInput> = {}): BashStagingInput => ({
	command,
	cwd: "/repo",
	onPrimaryCheckout: true,
	agentType: "engineering-manager",
	sessionId: "sess-1",
	worktreeRoot: "",
	at: "2026-07-25T00:00:00Z",
	...over,
});

describe("decideBashStagingAttribution", () => {
	it("records stage-all commands, including a chained command", () => {
		for (const command of ["git add -A", "git add .", "git status && git commit -am 'wip'"]) {
			expect(decideBashStagingAttribution(input(command)).kind).toBe("record");
		}
	});

	it("records cached control-plane removals with their named path", () => {
		const decision = decideBashStagingAttribution(input("git rm -r --cached .claude"));
		expect(decision.kind).toBe("record");
		if (decision.kind === "record") {
			expect(decision.record.kind).toBe("rm-cached");
			expect(decision.record.controlPlanePathArgs).toEqual([".claude"]);
		}
	});

	it("ignores low-signal and unrelated commands", () => {
		for (const command of ["git add packages/x/index.ts", "git commit --amend --no-edit", "ls -A"]) {
			expect(decideBashStagingAttribution(input(command)).kind).toBe("quiet");
		}
	});

	it("retains the worktree attribution in its rendered note", () => {
		const decision = decideBashStagingAttribution(
			input("git add -A", {onPrimaryCheckout: false, worktreeRoot: "/repo/.claude/worktrees/w1"}),
		);
		expect(decision.kind).toBe("record");
		if (decision.kind === "record") expect(renderBashStagingNote(decision.record)).toContain("a linked worktree");
	});
});
