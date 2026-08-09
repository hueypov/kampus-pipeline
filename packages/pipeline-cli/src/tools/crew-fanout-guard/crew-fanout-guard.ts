/**
 * `crew-fanout-guard` pure core — hold each crew bridge to its SANCTIONED spawn allowlist.
 *
 * The roster-law boundary keeps a read-only fanout from drifting into a "bridge runs the
 * pipeline" execution edge. This guard OWNS the per-bridge sanctioned allowlist and asserts
 * every mutating roster agent-type NOT on a bridge's allowlist is excluded by that bridge's
 * charter — so a future un-allowlisted, unstated agent-type reds the build.
 *
 * **The exclusion is a CHARTER rule, not a tool grant, and this guard is why (#121).** The
 * platform has no per-subagent deny primitive at this layer: a `disallowedTools` entry is
 * matched by its BASE TOOL NAME, so `Task(reviewer)` subtracts the whole `Task` tool and the
 * seat boots unable to spawn anything at all — the inverse of the intent, silently. The three
 * bridges each carried such a list and each booted without `Task`. So the guard checks two
 * separable things: the bridge def is SHAPED so its declared toolset actually resolves (no
 * self-denial, `Task` granted, no ungrantable name), and its charter STATES every exclusion.
 * What it cannot check is obedience — a charter rule is followed by the model reading it, not
 * enforced by the permission engine. Coverage is still structural, which is the property the
 * denylist was there for: an agent-type nobody classified reds the build either way.
 *
 * IO-free and total: every decision is a deterministic transform over already-gathered facts
 * (the parsed agent defs). The filesystem boundary (enumerate the agent dirs, read each def)
 * lives in `gate.ts`; this module never touches disk.
 *
 * Fail-closed by construction (the zero-scope fail-closed invariant): zero roster / zero
 * bridges, a missing bridge def, a mis-shaped bridge def, a stale allowlist entry, or any
 * uncovered mutating agent-type is a RED verdict — never a vacuous pass.
 */
import {parse as parseYaml} from "yaml";

/**
 * Read-only crew agent-types — write-tool-free by grant (the read-only fanout capability rule). Excluded from the
 * mutating roster: a bridge spawning one is context hygiene, not an execution edge. A NEW
 * agent-type defaults to MUTATING (it is not on this set), so it must be explicitly
 * allowlisted or excluded — the fail-closed default that catches a future roster addition.
 */
export const READ_ONLY_AGENTS: ReadonlySet<string> = new Set(["crew-investigator"]);

/** The three roster-law BRIDGE seats (the role-kind roster cardinality rule) whose spawn scope this guard enforces. */
export const BRIDGE_NAMES = [
	"crew-cartographer",
	"crew-chief-of-staff",
	"crew-intake-desk",
] as const;
export type BridgeName = (typeof BRIDGE_NAMES)[number];

/** The tool a bridge spawns through. Every bridge fans out to `crew-investigator`, so all three need it. */
export const FANOUT_TOOL = "Task";

/**
 * Tool names a top-level session is never served, so declaring one is a silent no-op — the
 * second silent-drop rule behind #121. A bridge that lists one reads as holding a capability
 * it does not have.
 */
export const UNGRANTABLE_TOOLS: ReadonlySet<string> = new Set(["Grep", "Glob"]);

/**
 * Each bridge's SANCTIONED spawn allowlist — the enforced source of truth, NOT whatever the
 * def happens to say. Every mutating roster agent-type absent from a bridge's allowlist must
 * be named in that bridge's charter exclusion; a roster addition absent from BOTH reds the
 * build. Encoding the allowlist here (rather than reading it back off the def) is what makes
 * it *enforced*: dropping an exclusion from a bridge's charter without adding the agent-type
 * here also reds the build.
 *
 * The allowlists track each bridge's charter: the cartographer keeps its Prototype-spike
 * `coder` and ideation-legwork agents; the chief-of-staff spawns nothing mutating (pure
 * verify-and-carry); the intake-desk owns the planning/canon seam (planner/canon/adr) plus its
 * report→triage loop (triager/reporter). See `claude-plugins/pipeline-crew/agents/`.
 *
 * The intake-desk's `reviewer` is the ONE sanctioned exception to "a bridge never spawns the
 * review gate", and it is scoped by GATE, not by trust: the intake-desk conducts `review-plan`
 * over an epic ledger it planned, and `review-plan` reads a ledger rather than a diff, so it
 * opens no path to the build. The four PR-stage gates stay the engine's. This list is a flat
 * set of agent-types and cannot express that scoping — the per-gate scope is stated in the
 * intake-desk's charter and in `../SPAWN-SCOPE.md`; what this entry buys is coverage, so the
 * charter and the enforced allowlist agree instead of the def reading as an uncovered gap.
 */
export const BRIDGE_ALLOWLIST: Record<BridgeName, ReadonlyArray<string>> = {
	"crew-cartographer": ["coder", "planner", "canon", "adr", "triager", "reporter"],
	"crew-chief-of-staff": [],
	"crew-intake-desk": ["planner", "reviewer", "canon", "adr", "triager", "reporter"],
};

/** One parsed agent def reduced to the facts the decision needs. */
export interface AgentDef {
	/** The agent-type name (its `name:` frontmatter), e.g. `crew-cartographer`. */
	readonly name: string;
	/** Tool names the def grants, from its `tools:` frontmatter. */
	readonly tools: ReadonlyArray<string>;
	/** Whether the def still carries a `disallowedTools:` key at all. */
	readonly declaresDisallowedTools: boolean;
	/** Agent-types the def's charter states it never spawns, from its `**Never spawn**` paragraph. */
	readonly charterExclusions: ReadonlyArray<string>;
}

/** One way a bridge def is mis-shaped: its declared toolset would not resolve as written. */
export interface DefShapeProblem {
	readonly bridge: string;
	readonly kind: "self-denial" | "missing-fanout-grant" | "ungrantable-tool";
	readonly detail: string;
}

/**
 * The guard verdict. A discriminated union so an invalid state is unrepresentable: a pass
 * never carries a gap list, and each failure shape carries exactly its evidence.
 */
export type CrewFanoutVerdict =
	| {
			readonly pass: true;
			readonly mutatingRoster: ReadonlyArray<string>;
			readonly bridges: ReadonlyArray<string>;
	  }
	/** No agent defs or no bridge defs in scope — fail closed, never a vacuous pass (the zero-scope fail-closed invariant). */
	| {readonly pass: false; readonly reason: "zero-scope"; readonly detail: string}
	/** An expected bridge def is absent — can't verify a bridge whose file vanished. */
	| {
			readonly pass: false;
			readonly reason: "missing-bridge";
			readonly missing: ReadonlyArray<string>;
	  }
	/** A bridge def declares a toolset that would not resolve as written (#121). */
	| {
			readonly pass: false;
			readonly reason: "def-shape";
			readonly problems: ReadonlyArray<DefShapeProblem>;
	  }
	/** An allowlist entry names an agent-type not in the roster — policy drift, fail closed. */
	| {
			readonly pass: false;
			readonly reason: "stale-allowlist";
			readonly entries: ReadonlyArray<{readonly bridge: string; readonly agent: string}>;
	  }
	/** A mutating roster agent-type is neither allowlisted nor charter-excluded for a bridge — the hole. */
	| {
			readonly pass: false;
			readonly reason: "uncovered";
			readonly gaps: ReadonlyArray<{readonly bridge: string; readonly agent: string}>;
	  };

/** Extract the YAML frontmatter block (between the leading `---` fences) and parse it. */
export const parseFrontmatter = (text: string): Record<string, unknown> | null => {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!m?.[1]) return null;
	const parsed = parseYaml(m[1]);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
};

/** Everything after the closing frontmatter fence — the def's prose charter. */
export const defBody = (text: string): string => {
	const m = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/.exec(text);
	return m ? text.slice(m[0].length) : text;
};

/** Read a YAML string-list frontmatter value, dropping anything that isn't a string. */
export const stringList = (value: unknown): ReadonlyArray<string> =>
	Array.isArray(value)
		? value.filter((v): v is string => typeof v === "string").map((v) => v.trim())
		: [];

/**
 * Pull the excluded agent-types out of a charter's `**Never spawn**` paragraph — every
 * inline-code token in it. A paragraph rather than a single line so the list may wrap; a
 * marked paragraph rather than free prose so the guard reads a declaration, not a guess.
 */
export const charterExclusions = (body: string): ReadonlyArray<string> => {
	const out = new Set<string>();
	for (const paragraph of body.split(/\r?\n[ \t]*\r?\n/)) {
		const text = paragraph.trimStart();
		if (!/^\*\*Never spawn\b/.test(text)) continue;
		for (const [, token] of text.matchAll(/`([^`]+)`/g)) if (token) out.add(token.trim());
	}
	return [...out];
};

/** Parse one agent-def markdown into an `AgentDef`; null when it has no `name`. */
export const parseAgentDef = (text: string): AgentDef | null => {
	const fm = parseFrontmatter(text);
	if (!fm || typeof fm.name !== "string") return null;
	return {
		name: fm.name,
		tools: stringList(fm.tools),
		declaresDisallowedTools: fm.disallowedTools !== undefined,
		charterExclusions: charterExclusions(defBody(text)),
	};
};

/** The facts the pure verdict is computed over — gathered at the filesystem boundary. */
export interface CrewFanoutInput {
	/** Every discovered agent-type name across both agent dirs (the roster). */
	readonly rosterAgents: ReadonlyArray<string>;
	/** The bridge defs actually found on disk, parsed. */
	readonly bridges: ReadonlyArray<AgentDef>;
}

/** The three def-shape checks, in the order a reader would apply them. */
const defShapeProblems = (bridges: ReadonlyArray<AgentDef>): ReadonlyArray<DefShapeProblem> => {
	const problems: Array<DefShapeProblem> = [];
	for (const bridge of bridges) {
		if (bridge.declaresDisallowedTools) {
			problems.push({
				bridge: bridge.name,
				kind: "self-denial",
				detail: "declares `disallowedTools`",
			});
		}
		if (!bridge.tools.includes(FANOUT_TOOL)) {
			problems.push({
				bridge: bridge.name,
				kind: "missing-fanout-grant",
				detail: `does not grant \`${FANOUT_TOOL}\``,
			});
		}
		for (const tool of bridge.tools) {
			if (!UNGRANTABLE_TOOLS.has(tool)) continue;
			problems.push({
				bridge: bridge.name,
				kind: "ungrantable-tool",
				detail: `declares ungrantable \`${tool}\``,
			});
		}
	}
	return problems;
};

/**
 * Decide the verdict. Fails closed on zero scope, a missing bridge, a mis-shaped bridge def, a
 * stale allowlist, or any mutating roster agent-type a bridge neither allowlists nor excludes.
 */
export const judge = (input: CrewFanoutInput): CrewFanoutVerdict => {
	if (input.rosterAgents.length === 0) {
		return {pass: false, reason: "zero-scope", detail: "no agent defs discovered"};
	}
	if (input.bridges.length === 0) {
		return {pass: false, reason: "zero-scope", detail: "no bridge defs discovered"};
	}

	const found = new Set(input.bridges.map((b) => b.name));
	const missing = BRIDGE_NAMES.filter((n) => !found.has(n));
	if (missing.length > 0) {
		return {pass: false, reason: "missing-bridge", missing};
	}

	const problems = defShapeProblems(input.bridges);
	if (problems.length > 0) {
		return {pass: false, reason: "def-shape", problems};
	}

	const rosterSet = new Set(input.rosterAgents);
	// A stale allowlist entry (an allowlisted agent-type no longer in the roster) means the
	// policy drifted from reality — fail closed so a rename/removal forces an allowlist update.
	const stale: Array<{bridge: string; agent: string}> = [];
	for (const bridge of BRIDGE_NAMES) {
		for (const agent of BRIDGE_ALLOWLIST[bridge]) {
			if (!rosterSet.has(agent)) stale.push({bridge, agent});
		}
	}
	if (stale.length > 0) {
		return {pass: false, reason: "stale-allowlist", entries: stale};
	}

	const mutatingRoster = [...rosterSet].filter((a) => !READ_ONLY_AGENTS.has(a)).sort();

	const gaps: Array<{bridge: string; agent: string}> = [];
	for (const bridge of input.bridges) {
		if (!(bridge.name in BRIDGE_ALLOWLIST)) continue;
		const allow = new Set(BRIDGE_ALLOWLIST[bridge.name as BridgeName]);
		const excluded = new Set(bridge.charterExclusions);
		for (const agent of mutatingRoster) {
			if (allow.has(agent) || excluded.has(agent)) continue;
			gaps.push({bridge: bridge.name, agent});
		}
	}
	if (gaps.length > 0) {
		return {pass: false, reason: "uncovered", gaps};
	}

	return {pass: true, mutatingRoster, bridges: input.bridges.map((b) => b.name).sort()};
};

/** Render the human-readable report for a verdict (the zero-scope fail-closed invariant §1 "emit what you scanned"). */
export const renderReport = (verdict: CrewFanoutVerdict): string => {
	if (verdict.pass) {
		return (
			`crew-fanout-guard: all ${verdict.bridges.length} crew bridge(s) [${verdict.bridges.join(", ")}] ` +
			`grant \`${FANOUT_TOOL}\` and charter-exclude every non-allowlisted mutating roster agent-type ` +
			`(${verdict.mutatingRoster.length} in the mutating roster: ${verdict.mutatingRoster.join(", ")})`
		);
	}
	if (verdict.reason === "zero-scope") {
		return (
			`crew-fanout-guard: ${verdict.detail} — fail-closed (the zero-scope fail-closed invariant). ` +
			"Is the repo root correct, or did the crew agent-def layout change?"
		);
	}
	if (verdict.reason === "missing-bridge") {
		return (
			`crew-fanout-guard: ${verdict.missing.length} expected crew bridge def(s) absent: ` +
			`${verdict.missing.join(", ")} — fail-closed (a bridge whose def vanished can't be verified). ` +
			"Restore the def or update BRIDGE_NAMES in crew-fanout-guard.ts."
		);
	}
	if (verdict.reason === "def-shape") {
		const lines = verdict.problems.map((p) => `  ${p.bridge} ${p.detail}`);
		return (
			`crew-fanout-guard: ${verdict.problems.length} bridge def(s) declare a toolset that would ` +
			`not resolve as written:\n${lines.join("\n")}\n\n` +
			"A `disallowedTools` entry is matched by its base tool name, so `Task(x)` subtracts the whole\n" +
			"`Task` tool and the bridge boots unable to spawn anything; `Grep`/`Glob` are never served to a\n" +
			"top-level session, so declaring one is a silent no-op (#121). Drop them, grant `Task`, and\n" +
			"state the per-subagent scope in the def's `**Never spawn**` charter paragraph instead."
		);
	}
	if (verdict.reason === "stale-allowlist") {
		const lines = verdict.entries.map(
			(e) => `  ${e.bridge} allowlists "${e.agent}" (not in the roster)`,
		);
		return (
			`crew-fanout-guard: ${verdict.entries.length} stale allowlist entr` +
			`${verdict.entries.length === 1 ? "y" : "ies"} — an allowlisted agent-type is no longer a ` +
			`known agent def:\n${lines.join("\n")}\n\n` +
			"An allowlist must track the roster. Remove the stale entry from BRIDGE_ALLOWLIST, or restore\n" +
			"the agent def it names."
		);
	}
	const lines = verdict.gaps.map(
		(g) => `  ${g.bridge} neither allowlists nor charter-excludes "${g.agent}"`,
	);
	return (
		`crew-fanout-guard: ${verdict.gaps.length} uncovered bridge×agent-type pair` +
		`${verdict.gaps.length === 1 ? "" : "s"} — a mutating roster agent-type is spawnable by a ` +
		`bridge that should scope it out:\n${lines.join("\n")}\n\n` +
		"Every mutating roster agent-type must be either on the bridge's sanctioned allowlist\n" +
		"(BRIDGE_ALLOWLIST in crew-fanout-guard.ts) or named in the bridge def's `**Never spawn**`\n" +
		"charter paragraph. A newly-added mutating agent-type must be classified before it can ship\n" +
		"(keep the read-only fanout off the execution edge)."
	);
};
