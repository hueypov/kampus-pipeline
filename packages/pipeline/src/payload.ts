/**
 * The typed workflow manifest is the single source for payload links, runtime status, and the
 * checked-in consumer catalogue. Keep the detailed skill/agent artifacts themselves independent:
 * this file only describes how they are surfaced and what authority they require.
 */
const CORE_SKILLS = [
	"adr", "architecture-audit", "author-skill", "canon", "deslop-comments", "diataxis", "doctor",
	"glossary", "heal-ci", "plan-epic", "report", "review-code", "review-design", "review-doc",
	"review-plan", "review-skill", "review-trivial", "ship-it", "triage", "wayfinder", "what-shipped",
	"write-code", "writing-clearly-and-concisely",
] as const;

const CORE_SUPPORT_FILES = ["gh-issue-intake-formats.md"] as const;
const CORE_AGENTS = ["adr", "canon", "coder", "planner", "reporter", "reviewer", "shipper", "triager"] as const;
const OPTIONAL_SKILLS = ["campaign", "release", "rite-audit"] as const;

export const CORE_SKILL_DEPENDENCIES: Readonly<Record<string, ReadonlyArray<string>>> = {
	adr: ["glossary", "report"], "architecture-audit": ["report"], "author-skill": ["review-skill"], canon: [],
	"deslop-comments": ["adr", "report"], diataxis: ["deslop-comments"], doctor: [], glossary: [],
	"heal-ci": ["report", "review-code", "review-doc", "ship-it", "write-code"], "plan-epic": [], report: [],
	"review-code": ["adr", "deslop-comments", "report", "review-plan"],
	"review-design": ["review-code", "review-doc", "review-skill"],
	"review-doc": ["adr", "diataxis", "report", "review-code", "writing-clearly-and-concisely"],
	"review-plan": ["report", "review-code"], "review-skill": ["report", "review-code", "review-doc"],
	"review-trivial": [], "ship-it": ["heal-ci"], triage: [], wayfinder: [], "what-shipped": [],
	"write-code": ["adr", "deslop-comments", "diataxis", "report", "writing-clearly-and-concisely"],
	"writing-clearly-and-concisely": ["deslop-comments"],
};

export const CORE_AGENT_SKILL_NAMES: Readonly<Record<string, ReadonlyArray<string>>> = {
	adr: ["adr"], canon: ["canon"], coder: ["write-code"], planner: ["plan-epic"], reporter: ["report"],
	reviewer: ["review-code", "review-design", "review-doc", "review-plan", "review-skill"], shipper: ["ship-it"], triager: ["triage"],
};

const GENERATED_WORKFLOWS = [
	["pipeline-toolkit", ".github/workflows/pipeline-toolkit.yml"],
	["pipeline-doc-safety", ".github/workflows/pipeline-doc-safety.yml"],
	["pipeline-delivery-gate", ".github/workflows/pipeline-delivery-gate.yml"],
	["pipeline-gitleaks", ".github/workflows/pipeline-gitleaks.yml"],
	["pipeline-doc-links", ".github/workflows/pipeline-doc-links.yml"],
	["pipeline-settings-env-guard", ".github/workflows/pipeline-settings-env-guard.yml"],
	["pipeline-unresolved-threads", ".github/workflows/pipeline-unresolved-threads.yml"],
] as const;

const LIFECYCLE_COMMANDS = ["main-sync", "trivial-diff classify", "class-probe classify", "guard-content-probe", "cp-cardinality decide", "cp-cardinality evidence-github-team", "reachability-guard check", "worktree-sweep", "gh-compat lint-skills", "ship-digest derive", "ref-guard", "primary-index-guard pre-commit"] as const;

type CatalogEntry = {
	readonly name: string;
	readonly artifactType: "skill" | "support-file" | "agent" | "generated-workflow" | "cli-command";
	readonly deliveryClass: "core-installed" | "optional-with-adapter";
	readonly entryPoint: string;
	readonly prerequisites: ReadonlyArray<string>;
	readonly authorityBoundary: string;
};

const coreEntries: ReadonlyArray<CatalogEntry> = [
	...CORE_SKILLS.map((name) => ({
		name, artifactType: "skill" as const, deliveryClass: "core-installed" as const,
		entryPoint: `.claude/skills/${name}`, prerequisites: CORE_SKILL_DEPENDENCIES[name] ?? [],
		authorityBoundary: "Repository-owned policy governs external operations.",
	})),
	...CORE_SUPPORT_FILES.map((name) => ({
		name, artifactType: "support-file" as const, deliveryClass: "core-installed" as const,
		entryPoint: `.claude/skills/${name}`, prerequisites: [], authorityBoundary: "Reference material only; no mutation authority.",
	})),
	...CORE_AGENTS.map((name) => ({
		name, artifactType: "agent" as const, deliveryClass: "core-installed" as const,
		entryPoint: `.claude/agents/${name}.md`, prerequisites: CORE_AGENT_SKILL_NAMES[name] ?? [],
		authorityBoundary: "Delegates to linked skills and repository policy.",
	})),
	...GENERATED_WORKFLOWS.map(([name, entryPoint]) => ({
		name, artifactType: "generated-workflow" as const, deliveryClass: "core-installed" as const,
		entryPoint, prerequisites: [], authorityBoundary: "Repository-owned checks and paths remain explicit.",
	})),
	...LIFECYCLE_COMMANDS.map((name) => ({
		name, artifactType: "cli-command" as const, deliveryClass: "core-installed" as const,
		entryPoint: `pipeline cli ${name}`, prerequisites: [".pipeline/agent-policy.json"],
		authorityBoundary: "Local safety command; mutations require explicit execution and configuration.",
	})),
];

const optionalEntries: ReadonlyArray<CatalogEntry> = OPTIONAL_SKILLS.map((name) => ({
	name, artifactType: "skill", deliveryClass: "optional-with-adapter",
	entryPoint: `.claude/skills/${name}`, prerequisites: [".pipeline/optional-workflow-policy.json", "repository-owned adapter"],
	authorityBoundary: "Enabled means linked only; provider and external authority remain repository-owned.",
}));

/** The canonical consumer-facing catalogue. */
export const WORKFLOW_CATALOG = {
	schemaVersion: 2,
	portableCore: {skills: CORE_SKILLS, supportFiles: CORE_SUPPORT_FILES, agents: CORE_AGENTS},
	archiveRequiresAdapter: {
		skills: OPTIONAL_SKILLS,
		activation: "Run `pipeline enable <workflow>` to link an optional skill. A repository-owned adapter and explicit authority policy are still required before external operations.",
	},
	entries: [...coreEntries, ...optionalEntries],
} as const;

/** Deterministic JSON payload used by the checked-in catalogue generator and drift check. */
export const renderWorkflowCatalog = (): string => `${JSON.stringify(WORKFLOW_CATALOG, null, "\t")}\n`;

/** Compatibility exports consumed by bootstrap and tests, all derived from the manifest above. */
export const CORE_SKILL_NAMES = new Set<string>(WORKFLOW_CATALOG.portableCore.skills);
export const CORE_WORKFLOW_SUPPORT_FILES = new Set<string>(WORKFLOW_CATALOG.portableCore.supportFiles);
export const CORE_AGENT_NAMES = new Set<string>(WORKFLOW_CATALOG.portableCore.agents);
export const ARCHIVED_SKILL_NAMES = new Set<string>(WORKFLOW_CATALOG.archiveRequiresAdapter.skills);
