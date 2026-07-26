import {describe, expect, it} from "vitest";
import {decideSweep, isManagedRoot, isReviewWorktree, safeRemoveArgs} from "./worktree-sweep.ts";

const base = {path: "/repo/.claude/worktrees/task", branch: "task", prunable: false, dirty: false, locked: false, recentlyActive: false, integrated: true, hasOpenPr: false};

describe("worktree sweep safety decision", () => {
	it("recognizes only configured roots and exact review prefixes", () => {
		expect(isManagedRoot("/repo/.claude/worktrees/task", ["/repo/.claude/worktrees"])).toBe(true);
		expect(isManagedRoot("/repo/other", ["/repo/.claude/worktrees"])).toBe(false);
		expect(isReviewWorktree("/tmp/review-head-42", ["review-head-"])).toBe(true);
		expect(isReviewWorktree("/tmp/unrelated-review-head-42", ["review-head-"])).toBe(false);
	});
	it("keeps every live or uncertain build worktree", () => {
		for (const changed of [
			{dirty: true}, {locked: true}, {recentlyActive: true}, {hasOpenPr: true}, {integrated: false},
		]) expect(decideSweep({...base, ...changed}, true, false).kind).toBe("keep");
	});
	it("removes only an idle clean integrated worktree or gone metadata", () => {
		expect(decideSweep(base, true, false)).toMatchObject({kind: "remove", reason: "clean-integrated-idle-worktree"});
		expect(decideSweep({...base, prunable: true}, true, false)).toMatchObject({kind: "remove", reason: "gone-directory-metadata"});
	});
	it("never constructs a force-removal invocation", () => {
		expect(safeRemoveArgs("/repo/.claude/worktrees/task")).toEqual(["worktree", "remove", "/repo/.claude/worktrees/task"]);
	});
});
