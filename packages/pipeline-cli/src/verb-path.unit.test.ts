/**
 * Unit tests for the verb-path guard. IO-free.
 *
 * The guard's two failure directions are asymmetric and both are tested: missing a bad path costs a
 * skill that cites a verb nobody built, but REFUSING A GOOD PATH breaks every working invocation.
 * The second is worse, so most of what follows pins the paths that must keep resolving.
 */
import {describe, expect, it} from "@effect/vitest";
import {registeredTools} from "./registry.ts";
import {checkVerbPath, refusalMessage, verbTree, type CommandLike} from "./verb-path.ts";

const cmd = (
	name: string,
	children: ReadonlyArray<CommandLike> = [],
	args: ReadonlyArray<{kind?: string; max?: {_tag?: string; value?: unknown}}> = [],
): CommandLike => ({
	name,
	subcommands: children.length > 0 ? [{commands: children}] : [],
	config: {arguments: args},
});

const TREE = verbTree("cli", [
	cmd("triage", [cmd("claim", [], [{kind: "argument"}]), cmd("queue")]),
	cmd("version"),
	cmd("wide", [cmd("open", [], [{kind: "argument", max: {_tag: "None"}}])]),
]);

describe("verbTree", () => {
	it("derives the surface from the registry rather than a list", () => {
		// A hand-written copy would rot and start refusing verbs that exist.
		const live = verbTree("cli", registeredTools);
		const names = live.children.map((c) => c.name);
		expect(names).toContain("triage");
		expect(names).toContain("ship-it");
		expect(live.children.find((c) => c.name === "triage")?.children.map((c) => c.name)).toContain(
			"enrich",
		);
	});
});

describe("checkVerbPath — what it refuses", () => {
	it("refuses an unknown subcommand even when --help follows", () => {
		// The whole point: the framework answers --help before it reports a parse error, so this
		// path previously exited 0 and made --help useless as proof a verb exists.
		const r = checkVerbPath(TREE, ["triage", "not-a-verb", "--help"]);
		expect(r?._tag).toBe("UnknownVerb");
		expect(r?._tag === "UnknownVerb" && r.expected).toContain("claim");
	});

	it("refuses an unknown tool at the root", () => {
		expect(checkVerbPath(TREE, ["not-a-tool"])?._tag).toBe("UnknownVerb");
	});

	it("refuses one operand more than the leaf declares", () => {
		expect(checkVerbPath(TREE, ["triage", "claim", "36", "37"])?._tag).toBe("ExtraOperand");
	});

	it("refuses any operand on a leaf that declares none", () => {
		expect(checkVerbPath(TREE, ["triage", "queue", "stray"])?._tag).toBe("ExtraOperand");
	});
});

describe("checkVerbPath — what it must never refuse", () => {
	it.each([
		[["triage"], "a group alone"],
		[["triage", "--help"], "a group's help"],
		[["triage", "claim", "--help"], "a leaf's help"],
		[["triage", "claim", "36"], "a leaf with its declared operand"],
		[["triage", "claim", "36", "--session", "abc"], "operand then flags"],
		[["triage", "queue"], "a leaf with no operands"],
		[["version"], "a top-level leaf"],
		[[], "no arguments at all"],
		[["--version"], "a leading global flag"],
	])("accepts %j — %s", (argv) => {
		expect(checkVerbPath(TREE, argv)).toBeNull();
	});

	it("stops at a bare -- and guards nothing after it", () => {
		expect(checkVerbPath(TREE, ["triage", "queue", "--", "anything", "at", "all"])).toBeNull();
	});

	it("does not count operands for a variadic argument", () => {
		// `leak-guard scan <file>…` is exactly this shape, and assuming one-operand-per-argument
		// made the first version of this guard refuse it. A `max` of `None` is unbounded.
		expect(checkVerbPath(TREE, ["wide", "open", "a", "b", "c", "d"])).toBeNull();
	});

	it("does not guard operands after a flag — the documented bound", () => {
		// Telling `--pr 47` from `--json 47` needs flag arity the framework does not expose reliably.
		// This test records the gap so it is a known bound rather than an assumed guarantee.
		expect(checkVerbPath(TREE, ["triage", "queue", "--stage", "x", "extratoken"])).toBeNull();
	});
});

describe("checkVerbPath — against the live registry", () => {
	const live = verbTree("pipeline-cli", registeredTools);

	it("accepts every real tool name", () => {
		for (const tool of live.children) {
			expect(checkVerbPath(live, [tool.name]), tool.name).toBeNull();
		}
	});

	it("accepts every real tool/subcommand pair", () => {
		for (const tool of live.children) {
			for (const sub of tool.children) {
				expect(checkVerbPath(live, [tool.name, sub.name]), `${tool.name} ${sub.name}`).toBeNull();
			}
		}
	});

	it("refuses a fabricated subcommand under every group", () => {
		for (const tool of live.children.filter((t) => t.children.length > 0)) {
			expect(checkVerbPath(live, [tool.name, "definitely-not-a-verb"])?._tag, tool.name).toBe(
				"UnknownVerb",
			);
		}
	});
});

describe("refusalMessage", () => {
	it("names the verb, the group, and what exists", () => {
		const r = checkVerbPath(TREE, ["triage", "clam"]);
		const msg = refusalMessage("cli", r!);
		expect(msg).toContain("'clam' is not a cli triage subcommand");
		expect(msg).toContain("available: claim, queue");
	});

	it("suggests a near miss", () => {
		expect(refusalMessage("cli", checkVerbPath(TREE, ["triage", "clam"])!)).toContain(
			"did you mean: claim",
		);
	});

	it("says an operand was refused rather than answered", () => {
		const msg = refusalMessage("cli", checkVerbPath(TREE, ["triage", "queue", "stray"])!);
		expect(msg).toContain("takes no positional operands");
		expect(msg).toContain("a different invocation than the one typed");
	});
});
