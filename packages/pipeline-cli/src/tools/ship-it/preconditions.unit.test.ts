/**
 * Unit tests for the `ship-it` pure core: the exit table and the precondition decisions. IO-free.
 */
import {describe, expect, it} from "@effect/vitest";
import {FAIL_CLOSED_POLICY} from "../class-probe/class-probe.ts";
import {
	checksPrecondition,
	EXIT,
	firstRefusal,
	gatePrecondition,
	gatesForFiles,
	guardPolicy,
	namespaceCheck,
	parseGateList,
	mergeablePrecondition,
	ok,
	refused,
} from "./preconditions.ts";

describe("gatePrecondition", () => {
	it("passes only a current-head PASS", () => {
		expect(gatePrecondition("code", {_tag: "pass", sha: "30e98f4c69fe"}).ok).toBe(true);
	});

	it.each([
		[{_tag: "fail"} as const, EXIT.VERDICT_FAIL],
		[{_tag: "stale", sha: "e1db540e"} as const, EXIT.VERDICT_STALE],
		[{_tag: "none"} as const, EXIT.NO_VERDICT],
		[{_tag: "unknown", reason: "gh exited 1"} as const, EXIT.PRECONDITION_UNKNOWN],
	])("refuses %s with its own code", (state, code) => {
		const p = gatePrecondition("code", state);
		expect(p.ok).toBe(false);
		expect(p.ok === false && p.code).toBe(code);
	});

	it("gives a stale verdict a different code from a failing one — different owners", () => {
		// stale → the reviewer must re-run; fail → the author must repair. Fusing them would send
		// one of them to the wrong stage.
		const stale = gatePrecondition("code", {_tag: "stale", sha: "abc1234"});
		const fail = gatePrecondition("code", {_tag: "fail"});
		expect(stale.ok === false && stale.code).not.toBe(fail.ok === false && fail.code);
	});
});

describe("checksPrecondition", () => {
	it("passes when checks reported and all passed", () => {
		expect(checksPrecondition({state: "green", failing: [], pending: []}).ok).toBe(true);
	});

	it("separates red from pending, because their owners differ", () => {
		const red = checksPrecondition({state: "red", failing: ["ci"], pending: []});
		const pending = checksPrecondition({state: "pending", failing: [], pending: ["ci"]});
		expect(red.ok === false && red.code).toBe(EXIT.CHECKS_RED);
		expect(pending.ok === false && pending.code).toBe(EXIT.CHECKS_PENDING);
	});

	it("treats NO checks as unknown, never as green", () => {
		// This is the vacuous-pass hole: a repository with no CI would otherwise merge on a gate
		// that confirmed nothing.
		const none = checksPrecondition({state: "none", failing: [], pending: []});
		expect(none.ok).toBe(false);
		expect(none.ok === false && none.code).toBe(EXIT.PRECONDITION_UNKNOWN);
	});
});

describe("mergeablePrecondition", () => {
	const base = {state: "open", draft: false, merged: false, mergeableState: "clean"};

	it("passes a clean open PR", () => {
		expect(mergeablePrecondition(base).ok).toBe(true);
	});

	it.each([
		[{...base, merged: true}, "already merged"],
		[{...base, state: "closed"}, "state is closed"],
		[{...base, draft: true}, "still a draft"],
		[{...base, mergeableState: "dirty"}, "conflicts with the base"],
	])("refuses %o", (pr, detail) => {
		const p = mergeablePrecondition(pr);
		expect(p.ok).toBe(false);
		expect(p.ok === false && p.code).toBe(EXIT.NOT_MERGEABLE);
		expect(p.detail).toBe(detail);
	});

	it("does not refuse an unknown mergeable_state — only a proven-dirty one", () => {
		// GitHub reports null while it computes mergeability; refusing on that would make the verb
		// flaky rather than safe.
		expect(mergeablePrecondition({...base, mergeableState: null}).ok).toBe(true);
	});
});

describe("firstRefusal", () => {
	it("returns null when everything passed", () => {
		expect(firstRefusal([ok("a", "-"), ok("b", "-")])).toBeNull();
	});

	it("reports one owner at a time, in evaluation order", () => {
		const r = firstRefusal([
			ok("gate", "-"),
			refused("checks", EXIT.CHECKS_RED, "failing"),
			refused("mergeable", EXIT.NOT_MERGEABLE, "dirty"),
		]);
		expect(r?.name).toBe("checks");
		expect(r?.code).toBe(EXIT.CHECKS_RED);
	});
});

describe("gatesForFiles — the scope the merge gate rests on", () => {
	const policy = {
		code: {includePatterns: ["^(packages|src)/"], excludePatterns: []},
		docs: {includePatterns: ["\\.md$"], excludePatterns: ["^(packages|src)/"]},
		skills: {includePatterns: ["(^|/)skills/"], excludePatterns: []},
		design: {includePatterns: ["\\.css$"], excludePatterns: []},
	};

	it("derives the gate from what changed, not from what was reviewed", () => {
		// The defect: the required set was built from the gates that already HAD a verdict, so a PR
		// nobody reviewed required nothing and the merge authority returned 0 on it. Against the old
		// implementation this input yields the same answer only by coincidence — the old code never
		// looked at files at all.
		expect(gatesForFiles(["packages/pipeline-cli/src/tools/review-code/brief.ts"], policy)).toEqual([
			"code",
		]);
	});

	it("requires only the gates the diff implicates", () => {
		// The concern the old behaviour protected: a repo that never touches design must not be told
		// it is missing a design verdict. Classifying the diff answers that properly.
		expect(gatesForFiles(["README.md"], policy)).toEqual(["doc"]);
		expect(gatesForFiles(["README.md"], policy)).not.toContain("design");
	});

	it("requires every gate a mixed diff implicates", () => {
		expect(gatesForFiles(["packages/a.ts", "docs/b.md", "skills/c/SKILL.md"], policy)).toEqual([
			"code",
			"doc",
			"skill",
		]);
	});

	it("returns null for an empty file list rather than an empty gate set", () => {
		// null refuses; `[]` would read as "no gates required" and pass — the exact reading that made
		// the merge gate vacuous.
		expect(gatesForFiles([], policy)).toBeNull();
	});

	it("classifies an unmatched path rather than exempting it", () => {
		expect(gatesForFiles([".gitignore"], policy)).toEqual(["code"]);
	});

	it("requires every gate when the policy cannot be trusted", () => {
		expect(gatesForFiles(["anything"], FAIL_CLOSED_POLICY)).toEqual(["code", "doc", "skill", "design"]);
	});
});

describe("parseGateList — an explicit --gates must not weaken the gate", () => {
	it("refuses a token that is not a gate rather than filtering it away", () => {
		// The live hole: filtering left an empty required set, so `--gates=nonsense` passed a PR with
		// no review at all, and `merge` reads the same value.
		expect(parseGateList("nonsense")).toBeNull();
	});

	it("refuses the classification policy's own plural spellings", () => {
		// Not a contrived input. The policy says `docs`/`skills`; the gate namespaces are
		// `doc`/`skill`. Typing the vocabulary this repository uses collapsed the gate to nothing.
		expect(parseGateList("docs")).toBeNull();
		expect(parseGateList("skills")).toBeNull();
	});

	it("refuses a value that names nothing at all", () => {
		expect(parseGateList(",")).toBeNull();
		expect(parseGateList("")).toBeNull();
		expect(parseGateList("   ")).toBeNull();
	});

	it("refuses a list where only SOME tokens are gates", () => {
		// Partially honouring an explicit assertion is worse than refusing it: the caller believes
		// it required two gates and got one.
		expect(parseGateList("code,nonsense")).toBeNull();
	});

	it("accepts the gates, with or without the review- prefix", () => {
		expect(parseGateList("code")).toEqual(["code"]);
		expect(parseGateList("review-code, doc")).toEqual(["code", "doc"]);
	});
});

describe("namespaceCheck — a verdict may only land in a namespace the diff requires", () => {
	const policy = {
		code: {includePatterns: ["^(packages|src)/"], excludePatterns: []},
		// Mirrors the real policy's shape: docs EXCLUDES skill dirs, exactly as the in-force
		// agent-policy.json does — an earlier fixture omitted that exclusion and disagreed with the
		// code about a skill diff, which was the fixture's defect, not the code's.
		docs: {includePatterns: ["\\.md$"], excludePatterns: ["^(packages|src)/", "(^|/)skills/"]},
		skills: {includePatterns: ["(^|/)skills/"], excludePatterns: []},
		design: {includePatterns: ["\\.css$"], excludePatterns: []},
	};

	it("allows a gate the diff requires", () => {
		expect(namespaceCheck("code", ["packages/a.ts"], policy)).toEqual({_tag: "allowed"});
	});

	it("refuses the habitual gate on a diff that classifies elsewhere, naming what it requires", () => {
		// The defect class behind #60's history: skill diffs carrying review-code verdicts, the
		// required gates unmet while the reviewer believed it reviewed.
		expect(namespaceCheck("code", ["skills/triage/SKILL.md"], policy)).toEqual({
			_tag: "refused",
			required: ["skill"],
		});
	});

	it("allows any one gate of a mixed diff's several", () => {
		// Posting one of N required gates is legitimate; COVERAGE of all N is ship-it's check, not
		// this one. Refusing here would force one reviewer to fabricate the sibling checklists.
		expect(namespaceCheck("doc", ["packages/a.ts", "docs/b.md"], policy)).toEqual({_tag: "allowed"});
	});

	it("returns unchecked for an empty file list rather than refusing", () => {
		// Deliberately weaker than ship-it's refusal on the same input: a merge on unknown scope is
		// unsafe, a review withheld on unknown scope is just lost. The caller warns aloud.
		expect(namespaceCheck("code", [], policy)).toEqual({_tag: "unchecked"});
	});

	it("returns unchecked for a NULL policy — never allowed", () => {
		// The inversion the first live probe demonstrated: defaulting a missing policy to the
		// classify-everything fail-closed policy makes every gate "required", so the refusal guard
		// never refuses — fail-open in exactly the worktrees reviews run from. Null means the check
		// cannot run, and the caller says so aloud.
		expect(namespaceCheck("design", ["packages/a.ts"], null)).toEqual({_tag: "unchecked"});
	});

	it("still refuses under an explicit classify-everything policy only by inclusion", () => {
		// If a caller DOES hand over the fail-closed policy, every namespace is genuinely in scope
		// and allowing is correct — the defect was the silent defaulting, not this input.
		expect(namespaceCheck("design", ["whatever"], FAIL_CLOSED_POLICY)).toEqual({_tag: "allowed"});
	});
});

describe("guardPolicy — the seam the review found fail-open", () => {
	const real = {policy: FAIL_CLOSED_POLICY, trusted: true};

	it("passes a trusted policy through", () => {
		expect(guardPolicy(real)).toBe(FAIL_CLOSED_POLICY);
	});

	it("returns null for an UNTRUSTED load — the loader's fail-closed fallback must not reach the guard", () => {
		// The loader never returns null; unreadable → classify-everything with trusted:false. Feeding
		// that policy to a refusal guard makes every gate "required" and nothing refusable — the
		// fail-open the review proved live from a policy-less worktree, after the core was fixed.
		expect(guardPolicy({policy: FAIL_CLOSED_POLICY, trusted: false})).toBeNull();
	});

	it("returns null outside a repository", () => {
		expect(guardPolicy(null)).toBeNull();
	});
});

describe("namespaceCheck — the page-size cap", () => {
	const policy = {
		code: {includePatterns: ["^(packages|src)/"], excludePatterns: []},
		docs: {includePatterns: ["\\.md$"], excludePatterns: ["^(packages|src)/", "(^|/)skills/"]},
		skills: {includePatterns: ["(^|/)skills/"], excludePatterns: []},
		design: {includePatterns: ["\\.css$"], excludePatterns: []},
	};

	it("returns unchecked at the page size rather than refusing on a possibly-truncated list", () => {
		// A dropped path here can drop the gate that would have ALLOWED the verdict — the inverse of
		// ship-it's direction, where truncation can only under-require. Unknown scope on a refusal
		// guard warns; it never guesses.
		const files = Array.from({length: 100}, (_, i) => `packages/f${i}.ts`);
		expect(namespaceCheck("code", files, policy)).toEqual({_tag: "unchecked"});
		expect(namespaceCheck("code", files.slice(0, 99), policy)).toEqual({_tag: "allowed"});
	});
});
