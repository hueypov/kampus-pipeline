/**
 * Pure-core tests for `crew-fanout-guard` (the originating work item): the frontmatter/charter
 * parse, the def-shape checks that keep a bridge's declared toolset resolvable (#121) and its
 * enforcement claims within what the grant delivers (#170), the enforced-allowlist coverage
 * decision, the future-agent fail-closed hole, and the zero-scope / missing-bridge /
 * stale-allowlist fail-closed verdicts (the zero-scope fail-closed invariant).
 * No IO — the filesystem seam is crossed in `gate.ts` and exercised in `gate.live.test.ts`.
 */
import {describe, expect, it} from "@effect/vitest";
import {
	type AgentDef,
	BRIDGE_ALLOWLIST,
	charterExclusions,
	type CrewFanoutInput,
	defBody,
	judge,
	parseAgentDef,
	parseFrontmatter,
	renderReport,
	stringList,
	unqualifiedEnforcementClaims,
} from "./crew-fanout-guard.ts";

// The full mutating roster the current crew ships (kampus-pipeline agents + the crew engine),
// plus the read-only investigator and the three bridges. This mirrors the live agent defs.
const PIPELINE_AGENTS = [
	"coder",
	"reviewer",
	"shipper",
	"planner",
	"canon",
	"adr",
	"triager",
	"reporter",
];
const CREW_AGENTS = [
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-engineering-manager",
	"crew-intake-desk",
	"crew-investigator",
];
const FULL_ROSTER = [...PIPELINE_AGENTS, ...CREW_AGENTS];

/** A well-shaped bridge def: `Task` granted, no self-denial, no ungrantable name, no overclaim. */
const bridge = (name: string, charterExclusions: ReadonlyArray<string>): AgentDef => ({
	name,
	tools: ["Read", "Bash", "Task", "mcp__pipeline-crew-mcp__channel_send"],
	declaresDisallowedTools: false,
	charterExclusions,
	enforcementClaims: [],
});

/** The read-only fanout as shipped: it holds `Bash`, which is what keeps the #170 check live. */
const INVESTIGATOR: AgentDef = {
	name: "crew-investigator",
	tools: ["Read", "Grep", "Glob", "Bash"],
	declaresDisallowedTools: false,
	charterExclusions: [],
	enforcementClaims: [],
};

/** A roster member the coverage decision counts by name, with nothing the shape checks read. */
const rosterDef = (name: string): AgentDef => ({
	name,
	tools: [],
	declaresDisallowedTools: false,
	charterExclusions: [],
	enforcementClaims: [],
});

// The three bridge defs, scoped to exactly cover their non-allowlisted mutating roster —
// i.e. the live `**Never spawn**` charter paragraphs, as agent-type names.
const CARTOGRAPHER = bridge("crew-cartographer", [
	"reviewer",
	"shipper",
	"crew-engineering-manager",
	"crew-chief-of-staff",
	"crew-intake-desk",
	"crew-cartographer",
]);
const CHIEF = bridge("crew-chief-of-staff", [
	"coder",
	"reviewer",
	"shipper",
	"planner",
	"canon",
	"adr",
	"triager",
	"reporter",
	"crew-engineering-manager",
	"crew-cartographer",
	"crew-intake-desk",
	"crew-chief-of-staff",
]);
// The intake-desk does NOT exclude `reviewer`: it is allowlisted, scoped to `review-plan` over an
// epic ledger — the one sanctioned bridge→review-gate spawn.
const INTAKE = bridge("crew-intake-desk", [
	"coder",
	"shipper",
	"crew-engineering-manager",
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-intake-desk",
]);

/**
 * A roster input: the given defs as parsed, plus a bare def for every other roster name. A def
 * absent from BOTH is one that is not on disk — which is how a missing bridge is modelled now that
 * the bridges are resolved out of the roster rather than passed beside it.
 */
const input = (
	defs: ReadonlyArray<AgentDef>,
	roster: ReadonlyArray<string> = FULL_ROSTER,
): CrewFanoutInput => {
	const given = new Set(defs.map((d) => d.name));
	return {defs: [...defs, ...roster.filter((n) => !given.has(n)).map(rosterDef)]};
};

const currentInput = (): CrewFanoutInput => input([CARTOGRAPHER, CHIEF, INTAKE, INVESTIGATOR]);

describe("parseFrontmatter / defBody / parseAgentDef", () => {
	it("extracts name, tools and the charter exclusions from a real bridge def", () => {
		const md = [
			"---",
			"name: crew-cartographer",
			"model: inherit",
			'tools: ["Read", "Bash", "Task"]',
			"---",
			"",
			"## Spawn scope",
			"",
			"**May spawn:** `crew-investigator`, `coder`.",
			"",
			"**Never spawn:** `reviewer`, `shipper`,",
			"`crew-engineering-manager`.",
			"",
			"Excluding `reviewer` keeps the merge gate off a bridge.",
		].join("\n");
		expect(parseAgentDef(md)).toEqual({
			name: "crew-cartographer",
			tools: ["Read", "Bash", "Task"],
			declaresDisallowedTools: false,
			// only the `**Never spawn**` paragraph is read — not the may-spawn list, and not the
			// prose below it that mentions `reviewer` again.
			charterExclusions: ["reviewer", "shipper", "crew-engineering-manager"],
			enforcementClaims: [],
		});
	});

	it("returns null for a def with no frontmatter or no name", () => {
		expect(parseAgentDef("no frontmatter here")).toBeNull();
		expect(parseAgentDef("---\nmodel: inherit\n---\nbody")).toBeNull();
	});

	it("flags a def that still declares disallowedTools", () => {
		const md = '---\nname: crew-intake-desk\ntools: ["Task"]\ndisallowedTools: ["Task(coder)"]\n---\nbody';
		expect(parseAgentDef(md)?.declaresDisallowedTools).toBe(true);
	});

	it("parseFrontmatter tolerates CRLF fences; defBody returns the prose after them", () => {
		expect(parseFrontmatter("---\r\nname: x\r\n---\r\nbody")).toEqual({name: "x"});
		expect(defBody("---\r\nname: x\r\n---\r\nbody")).toBe("body");
		expect(defBody("no frontmatter")).toBe("no frontmatter");
	});

	it("stringList keeps strings and tolerates a non-array", () => {
		expect(stringList(["Read", 7, " Task "])).toEqual(["Read", "Task"]);
		expect(stringList(undefined)).toEqual([]);
		expect(stringList("Task")).toEqual([]);
	});
});

describe("charterExclusions — read the `**Never spawn**` paragraph only", () => {
	it("returns empty when no charter paragraph is present (fail-closed downstream)", () => {
		expect(charterExclusions("You never spawn a reviewer, honest.")).toEqual([]);
	});

	it("ignores an inline-code token outside the charter paragraph", () => {
		const body = "Spawn `planner` freely.\n\n**Never spawn:** `shipper`.\n\nAnd never `merge`.";
		expect(charterExclusions(body)).toEqual(["shipper"]);
	});
});

describe("unqualifiedEnforcementClaims — a claim is read beside its qualifier (#170)", () => {
	const def = (description: string, body: string) =>
		`---\nname: crew-x\ndescription: '${description}'\ntools: ["Task"]\n---\n\n${body}`;

	it("flags a bare write-tool-free justification in the charter", () => {
		const md = def("a bridge", "Fan it out. It is write-tool-free — not an execution edge.");
		expect(unqualifiedEnforcementClaims(md)).toEqual(["write-tool-free"]);
	});

	it("accepts the same claim when the charter half is named beside it", () => {
		const md = def(
			"a bridge",
			"Fan it out. Its exclusions are grant-enforced and its `Bash` is read-only by charter.\n" +
				"It is write-tool-free in every other respect.",
		);
		expect(unqualifiedEnforcementClaims(md)).toEqual([]);
	});

	it("reads the description, which is the summary a spawner actually sees", () => {
		const md = def("a write-tool-free investigator", "Nothing to see in the charter.");
		expect(unqualifiedEnforcementClaims(md)).toEqual(["write-tool-free"]);
	});

	it("does not let a qualifier in a NEIGHBOURING bullet excuse the claim", () => {
		const md = def(
			"a bridge",
			"- **Reads.** Its `Bash` is read-only by charter.\n" +
				"- **Fanout.** The investigator holds no write tools, so it cannot mutate.",
		);
		expect(unqualifiedEnforcementClaims(md)).toEqual(["no write tools"]);
	});

	it("catches the structural-enforcement phrasings too", () => {
		expect(unqualifiedEnforcementClaims(def("x", "the invariant is enforced structurally"))).toEqual(
			["enforced structurally"],
		);
		expect(unqualifiedEnforcementClaims(def("x", "it is structurally enforced"))).toEqual([
			"structurally enforced",
		]);
	});
});

describe("judge — the enforcement-claim check (#170)", () => {
	const overclaiming = {...CARTOGRAPHER, enforcementClaims: ["write-tool-free"]};

	it("FAILS CLOSED when a def claims more enforcement than the read-only grant delivers", () => {
		const v = judge(input([overclaiming, CHIEF, INTAKE, INVESTIGATOR]));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "def-shape") {
			expect(v.problems).toContainEqual({
				def: "crew-cartographer",
				kind: "overclaimed-enforcement",
				detail: "claims `write-tool-free` without naming the charter half of the split",
			});
		} else {
			throw new Error("expected a def-shape verdict");
		}
	});

	it("catches the read-only agent overclaiming about ITSELF, not just the bridges", () => {
		const v = judge(
			input([
				CARTOGRAPHER,
				CHIEF,
				INTAKE,
				{...INVESTIGATOR, enforcementClaims: ["enforced structurally"]},
			]),
		);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "def-shape") {
			expect(v.problems.map((p) => p.def)).toEqual(["crew-investigator"]);
		} else {
			throw new Error("expected a def-shape verdict");
		}
	});

	it("goes quiet if the read-only grant is ever narrowed — the claim would then be true", () => {
		const narrowed = {...INVESTIGATOR, tools: ["Read", "Grep", "Glob"]};
		expect(judge(input([overclaiming, CHIEF, INTAKE, narrowed])).pass).toBe(true);
	});
});

describe("judge — the def-shape checks (#121)", () => {
	it("FAILS CLOSED when a bridge self-denies with disallowedTools", () => {
		const selfDenying = {...CARTOGRAPHER, declaresDisallowedTools: true};
		const v = judge(input([selfDenying, CHIEF, INTAKE, INVESTIGATOR]));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "def-shape") {
			expect(v.problems).toContainEqual({
				def: "crew-cartographer",
				kind: "self-denial",
				detail: "declares `disallowedTools`",
			});
		} else {
			throw new Error("expected a def-shape verdict");
		}
	});

	it("FAILS CLOSED when a bridge does not grant Task — its charter fanout could not resolve", () => {
		const noTask = {...CHIEF, tools: ["Read", "Bash"]};
		const v = judge(input([CARTOGRAPHER, noTask, INTAKE, INVESTIGATOR]));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "def-shape") {
			expect(v.problems.map((p) => p.kind)).toContain("missing-fanout-grant");
		} else {
			throw new Error("expected a def-shape verdict");
		}
	});

	it("FAILS CLOSED when a bridge declares an ungrantable tool name", () => {
		const withGrep = {...INTAKE, tools: [...INTAKE.tools, "Grep", "Glob"]};
		const v = judge(input([CARTOGRAPHER, CHIEF, withGrep, INVESTIGATOR]));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "def-shape") {
			expect(v.problems.map((p) => p.detail)).toEqual([
				"declares ungrantable `Grep`",
				"declares ungrantable `Glob`",
			]);
		} else {
			throw new Error("expected a def-shape verdict");
		}
	});
});

describe("judge — the enforced-allowlist coverage decision", () => {
	it("PASSES on the current, fully-scoped crew roster", () => {
		const v = judge(currentInput());
		expect(v.pass).toBe(true);
		if (v.pass) {
			// the read-only investigator is excluded from the mutating roster
			expect(v.mutatingRoster).not.toContain("crew-investigator");
			expect(v.mutatingRoster).toContain("coder");
			expect(v.bridges).toEqual(["crew-cartographer", "crew-chief-of-staff", "crew-intake-desk"]);
		}
	});

	it("FAILS CLOSED on a FUTURE mutating agent-type no bridge allowlists or excludes (the #3606 hole)", () => {
		const v = judge(
			input([CARTOGRAPHER, CHIEF, INTAKE, INVESTIGATOR], [...FULL_ROSTER, "crew-auditor"]),
		);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "uncovered") {
			// every bridge is missing an exclusion for the new type, and none allowlists it
			expect(v.gaps.map((g) => g.bridge).sort()).toEqual([
				"crew-cartographer",
				"crew-chief-of-staff",
				"crew-intake-desk",
			]);
			expect(v.gaps.every((g) => g.agent === "crew-auditor")).toBe(true);
		} else {
			throw new Error(`expected an uncovered verdict, got ${v.pass ? "pass" : v.reason}`);
		}
	});

	it("FAILS CLOSED when a bridge silently drops a charter exclusion for a non-allowlisted type", () => {
		// reviewer is NOT on the cartographer allowlist; removing its exclusion must red.
		const weakened = bridge(
			"crew-cartographer",
			CARTOGRAPHER.charterExclusions.filter((t) => t !== "reviewer"),
		);
		const v = judge(input([weakened, CHIEF, INTAKE, INVESTIGATOR]));
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "uncovered") {
			expect(v.gaps).toContainEqual({bridge: "crew-cartographer", agent: "reviewer"});
		} else {
			throw new Error("expected an uncovered verdict");
		}
	});

	it("does NOT require a bridge to exclude an agent-type on its own allowlist", () => {
		// intake-desk allowlists planner/canon/adr — it names none of them, and stays green.
		const v = judge(currentInput());
		expect(v.pass).toBe(true);
		expect(BRIDGE_ALLOWLIST["crew-intake-desk"]).toContain("planner");
		expect(INTAKE.charterExclusions).not.toContain("planner");
	});

	it("sanctions the intake-desk's review-plan `reviewer` while every other bridge excludes it", () => {
		// The one bridge→review-gate spawn: allowlisted for the intake-desk (scoped to review-plan
		// over an epic ledger), and still charter-excluded by both peer bridges.
		expect(BRIDGE_ALLOWLIST["crew-intake-desk"]).toContain("reviewer");
		expect(INTAKE.charterExclusions).not.toContain("reviewer");
		expect(BRIDGE_ALLOWLIST["crew-cartographer"]).not.toContain("reviewer");
		expect(CARTOGRAPHER.charterExclusions).toContain("reviewer");
		expect(BRIDGE_ALLOWLIST["crew-chief-of-staff"]).not.toContain("reviewer");
		expect(CHIEF.charterExclusions).toContain("reviewer");
		expect(judge(input([CARTOGRAPHER, CHIEF, INTAKE])).pass).toBe(true);
	});

	it("fails closed on zero roster and on zero bridges (the zero-scope fail-closed invariant)", () => {
		expect(judge({defs: []})).toMatchObject({pass: false, reason: "zero-scope"});
		// a roster with no bridge def in it at all
		expect(judge(input([], PIPELINE_AGENTS))).toMatchObject({pass: false, reason: "zero-scope"});
	});

	it("fails closed when an expected bridge def is absent", () => {
		const v = judge(
			input(
				[CARTOGRAPHER, INTAKE, INVESTIGATOR],
				FULL_ROSTER.filter((a) => a !== "crew-chief-of-staff"),
			),
		);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "missing-bridge") {
			expect(v.missing).toEqual(["crew-chief-of-staff"]);
		} else {
			throw new Error("expected a missing-bridge verdict");
		}
	});

	it("fails closed on a stale allowlist entry (allowlists an agent not in the roster)", () => {
		// drop `reporter` from the roster while an allowlist still names it.
		const v = judge(
			input([CARTOGRAPHER, CHIEF, INTAKE, INVESTIGATOR], FULL_ROSTER.filter((a) => a !== "reporter")),
		);
		expect(v.pass).toBe(false);
		if (!v.pass && v.reason === "stale-allowlist") {
			expect(v.entries.map((e) => e.agent)).toContain("reporter");
		} else {
			throw new Error("expected a stale-allowlist verdict");
		}
	});
});

describe("renderReport", () => {
	it("names the scanned bridges + mutating roster on a pass", () => {
		const report = renderReport(judge(currentInput()));
		expect(report).toContain("crew-cartographer");
		expect(report).toContain("mutating roster");
	});

	it("names the offending bridge×agent pair on an uncovered fail", () => {
		const v = judge(
			input([CARTOGRAPHER, CHIEF, INTAKE, INVESTIGATOR], [...FULL_ROSTER, "crew-auditor"]),
		);
		const report = renderReport(v);
		expect(report).toContain("crew-auditor");
		expect(report).toContain("neither allowlists nor charter-excludes");
	});

	it("explains the whole-tool subtraction on a def-shape fail", () => {
		const v = judge(
			input([{...CARTOGRAPHER, declaresDisallowedTools: true}, CHIEF, INTAKE, INVESTIGATOR]),
		);
		const report = renderReport(v);
		expect(report).toContain("subtracts the whole");
		expect(report).toContain("Never spawn");
	});

	it("explains the grant/charter split on an overclaimed-enforcement fail, and only then", () => {
		const overclaiming = {...CHIEF, enforcementClaims: ["write-tool-free"]};
		const report = renderReport(judge(input([CARTOGRAPHER, overclaiming, INTAKE, INVESTIGATOR])));
		expect(report).toContain("charter-enforced for `Bash`");
		// the #121 note is for the toolset-shape kinds; it does not ride along on this one
		expect(report).not.toContain("subtracts the whole");
	});
});
