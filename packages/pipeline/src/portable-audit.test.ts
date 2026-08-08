import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {CORE_AGENT_NAMES, CORE_AGENT_SKILL_NAMES, CORE_SKILL_DEPENDENCIES, CORE_SKILL_NAMES, CORE_WORKFLOW_SUPPORT_FILES, renderWorkflowCatalog, WORKFLOW_CATALOG} from "./payload.ts";
import {collectPayloadFiles} from "./portable-files.ts";

const root = join(process.cwd(), "../..");
const portablePaths = [
	"bin/pipeline",
	"packages/pipeline/src/bin.ts",
	"packages/pipeline/src/payload.ts",
	"templates/glossary",
	"templates/pipeline",
	"templates/github/workflows",
	"claude-plugins/kampus-pipeline/hooks",
	...Array.from(CORE_SKILL_NAMES, (name) => `claude-plugins/kampus-pipeline/skills/${name}`),
	...Array.from(CORE_WORKFLOW_SUPPORT_FILES, (name) => `claude-plugins/kampus-pipeline/skills/${name}`),
	// The eval sets, named explicitly since ADR 0001 moved them out of the skill directories. They
	// used to be swept up by the per-skill entries above, because `collectPayloadFiles` recurses —
	// so the forbidden-string audit covered ~43KB of eval prose without anyone listing it. Dropping
	// the line would leave every test here green while silently covering five fewer files, which is
	// the shape this suite exists to catch. Eval prompts describe concrete engineering scenarios,
	// which is exactly the prose that attracts a real repository path.
	"claude-plugins/kampus-pipeline/evals",
];
const adrPaths = [
	"claude-plugins/kampus-pipeline/skills/adr/SKILL.md",
	"claude-plugins/kampus-pipeline/agents/adr.md",
];
const forbidden = new RegExp(
	["pnpm dlx pipeline-cli", "npm install pipeline-cli", "publish .*pipeline-cli", "pho" + "enix", "cloud" + "flare", "cf-utils", "apps/web"].join("|"),
	"i",
);
const adrForbidden = new RegExp(
	["0126", "0066", "0048", "0053", "0075", "Projects-classic", "status:planning", "<related work item>"].join("|"),
	"i",
);
const agentForbidden = new RegExp(
	[
		"pho" + "enix",
		"cloud" + "flare",
		"cf-utils",
		"Projects-classic",
		"apps/web",
		"<configured-control-plane-team>",
		"status:needs-triage",
		"status:triaged",
		"type:epic",
		"type:\\*",
	].join("|"),
	"i",
);
const sourceSpecificSkillRules: Readonly<Record<string, RegExp>> = {
	glossary: /sözlük|Turkish dev-terms|apps\/\*\/src\/features|-- apps packages|apps packages/i,
	diataxis: /TR\/EN language law|product\/user-facing copy stays Turkish|ADRs, `\.patterns\/`/i,
	"deslop-comments": /git worktree add[^\n]*\bmain\b|pnpm typecheck|pnpm format/i,
	"writing-clearly-and-concisely": /Turkish stays Turkish|(?:\.\.\/){4}\.glossary\/LANGUAGE\.md/i,
};
const archivedWorkflowForbidden = new RegExp(
	[
		"pho" + "enix",
		"cloud" + "flare",
		"flagship",
		"cf-utils",
		"Projects-classic",
		"apps/web",
		"çaylak",
		"yazar",
		"@kampus/",
		"<related work item>",
		"<configured-control-plane-team>",
		"<repository URL>",
		"<shared-automation-login>",
		"status:[a-z-]+",
		"type:[a-z*-]+",
		"area:[a-z*-]+",
		"\\bmain\\b",
	].join("|"),
	"i",
);

/**
 * The payload files under a path. Bounded to the repository — see `portable-files.ts` for why a
 * walk that follows a symlink out of the tree audits somebody else's copy of the pipeline (#36).
 */
const files = (path: string): string[] => collectPayloadFiles(root, path);
const archivedWorkflowFiles = [
	"claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md",
	"claude-plugins/kampus-pipeline/skills/validate-cycle-absence.sh",
	"claude-plugins/kampus-pipeline/skills/validate-cycle-presence.sh",
	"claude-plugins/kampus-pipeline/skills/validate-skills.sh",
]
	.flatMap(files)
	.filter((file) => !file.includes("/dimensions/vendor/"));

describe("portable toolkit boundary", () => {
	it("keeps the retired @kampus scope out of the source tree", () => {
		// The de-scope sweep (#72) is durable only if a guard sees the whole source tree: the
		// archived-workflow list below covers four payload files and none of the packages, so a
		// new tool copying an older file's tag shape would reintroduce the scope with nothing
		// going red. Two deliberate carriers are excluded by path — this file's own forbidden
		// strings, and CHANNEL-TOOL.md's historical note about the old scoped token.
		const scope = "@kampus" + "/";
		const keepers = new Set([
			join(root, "packages/pipeline/src/portable-audit.test.ts"),
			join(root, "claude-plugins/pipeline-crew/CHANNEL-TOOL.md"),
		]);
		const matches = [
			"packages/pipeline/src",
			"packages/pipeline-cli/src",
			"packages/pipeline-cli/TOOLS.md",
			"packages/pipeline-crew-mcp/src",
			"packages/pipeline-crew-mcp/docs",
			"claude-plugins",
			"templates",
		]
			.flatMap(files)
			.filter((file) => !keepers.has(file) && !file.includes("/dimensions/vendor/"))
			.filter((file) => readFileSync(file, "utf8").includes(scope));
		expect(matches).toEqual([]);
	});

	it("contains no registry installer or project-specific policy in activated payloads", () => {
		const matches = portablePaths
			.flatMap(files)
			.flatMap((file) => {
				const match = readFileSync(file, "utf8").match(forbidden);
				return match ? [`${file}: ${match[0]}`] : [];
			});
		expect(matches).toEqual([]);
	});

	it("ships a repository-agnostic ADR contract", () => {
		const matches = adrPaths
			.flatMap(files)
			.flatMap((file) => {
				const match = readFileSync(file, "utf8").match(adrForbidden);
				return match ? [`${file}: ${match[0]}`] : [];
			});
		expect(matches).toEqual([]);
	});

	it("generates an ADR validator with the document-safety workflow", () => {
		const workflow = readFileSync(join(root, "templates/github/workflows/pipeline-doc-safety.yml"), "utf8");
		expect(workflow).toContain("./.pipeline/toolkit/bin/pipeline cli decisions-index validate");
	});

	it("ships a generic core delivery-authority policy without source taxonomy", () => {
		const policy = JSON.parse(readFileSync(join(root, "templates/pipeline/agent-policy.json"), "utf8")) as {
			schemaVersion?: unknown;
			github?: {
				issueMutation?: unknown;
				implementation?: {enabled?: unknown};
				planning?: {enabled?: unknown; epicEligibilityQuery?: unknown};
				triage?: {enabled?: unknown; queueQuery?: unknown};
				review?: {uiPaths?: unknown; requiredChecks?: unknown; classification?: unknown};
				shipping?: {
					enabled?: unknown;
					controlPlanePaths?: unknown;
					requiredApprovals?: unknown;
					shipDigest?: unknown;
					guardContent?: {enabled?: unknown; decisionRecordPaths?: unknown; vocabularyPatterns?: unknown};
					protectedChangeApproval?: unknown;
				};
			};
		};
		expect(policy.schemaVersion).toBe(1);
		expect(policy.github).toMatchObject({
			issueMutation: true,
			implementation: {enabled: true},
			planning: {enabled: true, epicEligibilityQuery: null},
			triage: {enabled: true, queueQuery: null},
			review: {uiPaths: [], requiredChecks: [], classification: expect.any(Object)},
			shipping: {
				enabled: true,
				// The shipped list stays empty because a portable template cannot know an adopter's
				// source taxonomy. It is not a vacuous gate: `parseProtectedChangePolicy` refuses an
				// empty boundary, so this default classifies every change as protected (#134).
				controlPlanePaths: [],
				requiredApprovals: 0,
				shipDigest: expect.any(Object),
				guardContent: {enabled: false, decisionRecordPaths: [], vocabularyPatterns: []},
				protectedChangeApproval: expect.any(Object),
			},
		});
		expect(policy.github?.shipping?.guardContent).toEqual({
			enabled: false,
			decisionRecordPaths: [],
			vocabularyPatterns: [],
		});
		expect(policy.github?.shipping?.shipDigest).toMatchObject({
			categories: {order: [], labels: {}, fallbackLabel: "Uncategorized"},
			types: {order: [], labels: {}, fallbackLabel: "Uncategorized"},
			releaseState: {adapter: null, mergedWithoutReleaseEvidence: "unknown"},
		});
		expect(policy.github?.shipping?.protectedChangeApproval).toEqual({
			authority: {provider: "github-team", organization: null, teamSlug: null},
			requiredNonAuthorApprovals: 1,
			soleAuthorException: {enabled: false, commentPattern: null},
		});
	});

	it("ships a generic current-head delivery gate and merge reconciliation workflow", () => {
		const workflow = readFileSync(join(root, "templates/github/workflows/pipeline-delivery-gate.yml"), "utf8");
		expect(workflow).toContain("pipeline cli review-head resolve");
		expect(workflow).toContain("pipeline cli verdict read");
		expect(workflow).toContain("requiredChecks");
		expect(workflow).toContain("merge_commit_sha");
		expect(workflow).toContain("pipeline cli class-probe classify");
	});

	it("ships portable security, documentation, settings, and review-thread workflow templates", () => {
		const workflows = [
			["pipeline-gitleaks.yml", "./gitleaks git .", false],
			["pipeline-doc-links.yml", "lychee --offline", false],
			["pipeline-settings-env-guard.yml", "pipeline cli settings-env-guard check", true],
			["pipeline-unresolved-threads.yml", "pipeline cli unresolved-threads-guard check --pr", true],
		] as const;
		for (const [name, expected, requiresToolkit] of workflows) {
			const workflow = readFileSync(join(root, "templates/github/workflows", name), "utf8");
			expect(workflow).toContain(expected);
			if (requiresToolkit) expect(workflow).toContain(".pipeline/toolkit");
		}
	});

	it("ships lifecycle safety commands and their repository-owned configuration boundary", () => {
		const policy = readFileSync(join(root, "templates/pipeline/agent-policy.json"), "utf8");
		const matrix = readFileSync(join(root, "templates/pipeline/cli-capability-matrix.md"), "utf8");
		const registry = readFileSync(join(root, "packages/pipeline-cli/src/registry.ts"), "utf8");
		expect(policy).toContain('"primaryBranch": null');
		expect(policy).toContain('"primaryRemote": null');
		expect(policy).not.toContain('"refGuard"');
		expect(policy).toContain('"trivialDiff"');
		expect(policy).toContain('"managedRoots"');
		expect(matrix).toContain("`main-sync`");
		expect(matrix).toContain("`trivial-diff classify`");
		expect(matrix).toContain("`worktree-sweep`");
		expect(matrix).toContain("`ship-digest`");
		expect(matrix).toContain("`ref-guard`");
		expect(registry).toContain("mainSyncCommand");
		expect(registry).toContain("trivialDiffCommand");
		expect(registry).toContain("worktreeSweepCommand");
		expect(registry).toContain("shipDigestCommand");
		expect(registry).toContain("refGuardCommand");
	});



	it("keeps the retained archive free of source rules and unresolved provenance", () => {
		const matches = archivedWorkflowFiles.flatMap((file) => {
			const match = readFileSync(file, "utf8").match(archivedWorkflowForbidden);
			return match ? [`${file}: ${match[0]}`] : [];
		});
		expect(matches).toEqual([]);
	});

	it("ships every active skill and excludes its source-specific policy", () => {
		const missingSkills: string[] = [];
		const sourcePolicyMatches: string[] = [];
		for (const skill of CORE_SKILL_NAMES) {
			const file = join(root, "claude-plugins/kampus-pipeline/skills", skill, "SKILL.md");
			if (!existsSync(file)) {
				missingSkills.push(skill);
				continue;
			}
			const rule = sourceSpecificSkillRules[skill];
			const match = rule ? readFileSync(file, "utf8").match(rule) : null;
			if (match) sourcePolicyMatches.push(`${skill}: ${match[0]}`);
		}
		expect(missingSkills).toEqual([]);
		expect(sourcePolicyMatches).toEqual([]);
	});

	it("declares every required core-skill dependency", () => {
		expect(new Set(Object.keys(CORE_SKILL_DEPENDENCIES))).toEqual(CORE_SKILL_NAMES);
		const linksOutsideThePortableContract: string[] = [];
		for (const skill of CORE_SKILL_NAMES) {
			const file = join(root, "claude-plugins/kampus-pipeline/skills", skill, "SKILL.md");
			const text = readFileSync(file, "utf8");
			for (const match of text.matchAll(/\.\.\/([a-z-]+)\/SKILL\.md/g)) {
				const dependency = match[1];
				if (!dependency || !CORE_SKILL_DEPENDENCIES[skill]?.includes(dependency)) {
					linksOutsideThePortableContract.push(`${skill} -> ${dependency ?? "unknown"}`);
				}
			}
			for (const dependency of CORE_SKILL_DEPENDENCIES[skill] ?? []) {
				if (!CORE_SKILL_NAMES.has(dependency)) {
					linksOutsideThePortableContract.push(`${skill} -> ${dependency}`);
				}
			}
		}
		expect(linksOutsideThePortableContract).toEqual([]);
	});

	it("keeps every installed agent's required procedures in the core payload", () => {
		expect(CORE_AGENT_SKILL_NAMES).toEqual({
			adr: ["adr"],
			canon: ["canon"],
			coder: ["write-code"],
			planner: ["plan-epic"],
			reporter: ["report"],
			reviewer: ["review-code", "review-design", "review-doc", "review-plan", "review-skill"],
			shipper: ["ship-it"],
			triager: ["triage"],
		});
		expect(new Set(Object.keys(CORE_AGENT_SKILL_NAMES))).toEqual(CORE_AGENT_NAMES);
		for (const [agent, skills] of Object.entries(CORE_AGENT_SKILL_NAMES)) {
			for (const skill of skills) expect(CORE_SKILL_NAMES.has(skill), `${agent} -> ${skill}`).toBe(true);
		}
	});

	it("ships a policy-gated, repository-agnostic installed agent fleet", () => {
		const missingAgents: string[] = [];
		const missingPolicyGate: string[] = [];
		const sourcePolicyMatches: string[] = [];
		for (const agent of CORE_AGENT_NAMES) {
			const file = join(root, "claude-plugins/kampus-pipeline/agents", `${agent}.md`);
			if (!existsSync(file)) {
				missingAgents.push(agent);
				continue;
			}
			const text = readFileSync(file, "utf8");
			if (!text.includes(".pipeline/agent-policy.json")) missingPolicyGate.push(agent);
			const match = text.match(agentForbidden);
			if (match) sourcePolicyMatches.push(`${agent}: ${match[0]}`);
		}
		expect(missingAgents).toEqual([]);
		expect(missingPolicyGate).toEqual([]);
		expect(sourcePolicyMatches).toEqual([]);
	});
});
