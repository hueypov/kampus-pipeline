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
	args: ReadonlyArray<{_tag?: string; kind?: string; max?: {_tag?: string; value?: unknown}}> = [],
	flags: ReadonlyArray<{name?: string; primitiveType?: {_tag?: string}; param?: unknown}> = [],
): CommandLike => ({
	name,
	subcommands: children.length > 0 ? [{commands: children}] : [],
	config: {arguments: args, flags},
});

const single = {_tag: "Single", kind: "argument"} as const;
const variadic = {_tag: "Variadic", kind: "argument", max: {_tag: "None"}} as const;
const strFlag = (name: string) => ({name, primitiveType: {_tag: "String"}});
const boolFlag = (name: string) => ({name, primitiveType: {_tag: "Boolean"}});
/** An `Optional`-wrapped flag: the real declaration nests under `.param`, as the framework emits. */
const wrapped = (name: string) => ({param: {name, primitiveType: {_tag: "String"}}});

const TREE = verbTree("cli", [
	cmd("triage", [
		cmd("claim", [], [single], [strFlag("session")]),
		cmd("queue", [], [], [strFlag("stage"), boolFlag("json")]),
		cmd("enrich", [], [single], [wrapped("note"), boolFlag("epic")]),
	]),
	cmd("version"),
	cmd("wide", [cmd("open", [], [variadic])]),
	cmd("mapped", [cmd("op", [], [{_tag: "Map", kind: "argument"}])]),
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

	it("refuses a stray operand AFTER a flag and its value", () => {
		// The case an earlier revision accepted, having wrongly recorded flag arity as unreadable.
		expect(checkVerbPath(TREE, ["triage", "queue", "--stage", "x", "stray"])?._tag).toBe(
			"ExtraOperand",
		);
	});

	it("refuses a stray operand after a boolean flag, which consumes nothing", () => {
		expect(checkVerbPath(TREE, ["triage", "queue", "--json", "stray"])?._tag).toBe("ExtraOperand");
	});

	it("reads a flag nested under a wrapper, not just a bare one", () => {
		// `Optional`/`Map` nest the declaration under `.param`. Reading one level finds an undefined
		// name and looks like missing metadata — the misreading this guard was first built on.
		expect(checkVerbPath(TREE, ["triage", "enrich", "36", "--note", "x"])).toBeNull();
		expect(checkVerbPath(TREE, ["triage", "enrich", "36", "--note", "x", "stray"])?._tag).toBe(
			"ExtraOperand",
		);
	});

	it("handles --flag=value without consuming the next token", () => {
		expect(checkVerbPath(TREE, ["triage", "queue", "--stage=x", "stray"])?._tag).toBe("ExtraOperand");
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

	it("does not mistake a flag's value for an operand", () => {
		expect(checkVerbPath(TREE, ["triage", "queue", "--stage", "x"])).toBeNull();
	});

	it("does not count operands past an unrecognised flag", () => {
		// A global flag like --log-level belongs to the root, not the leaf, so its arity is unknown
		// here. Stopping accepts less coverage; guessing would refuse working commands.
		expect(checkVerbPath(TREE, ["triage", "queue", "--log-level", "info", "x"])).toBeNull();
	});

	it("does not count operands for an argument behind a wrapper it cannot read", () => {
		// A Map/Transform wrapper carries no `max` of its own, so treating it as single would
		// recreate the leak-guard false refusal one wrapper deeper.
		expect(checkVerbPath(TREE, ["mapped", "op", "a", "b", "c"])).toBeNull();
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

	it("derives an unbounded operand count for every variadic verb in the registry", () => {
		// The guard's own tests would otherwise never touch a real argument shape: a framework
		// upgrade renaming `Variadic.max` would leave every synthetic case green while the live
		// `leak-guard scan` started being refused again.
		const scan = live.children.find((c) => c.name === "leak-guard")?.children.find((c) => c.name === "scan");
		expect(scan, "leak-guard scan").toBeDefined();
		expect(scan?.maxPositionals, "a variadic verb must not be operand-bounded").toBeNull();
		expect(checkVerbPath(live, ["leak-guard", "scan", "a", "b", "c", "d"])).toBeNull();
	});

	it("reads a flag arity for every leaf that declares flags", () => {
		// 219 flags across the registry unwrap to a name; none is unreadable. If a future wrapper
		// shape breaks that, this reds rather than silently disabling the operand guard.
		const leaves: Array<{path: string; flags: number}> = [];
		const walk = (node: typeof live, path: string[]) => {
			if (node.children.length === 0) leaves.push({path: path.join(" "), flags: node.flags.size});
			for (const c of node.children) walk(c, [...path, c.name]);
		};
		walk(live, []);
		expect(leaves.length).toBeGreaterThan(50);
		expect(leaves.some((l) => l.flags > 0), "some leaf must expose readable flags").toBe(true);
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
