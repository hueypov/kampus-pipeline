import {execFileSync, spawnSync} from "node:child_process";
import {chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {CORE_AGENT_NAMES, CORE_SKILL_NAMES, CORE_WORKFLOW_SUPPORT_FILES} from "./payload.ts";

const roots: string[] = [];

const write = (path: string, text: string, executable = false): void => {
	mkdirSync(join(path, ".."), {recursive: true});
	writeFileSync(path, text);
	if (executable) chmodSync(path, 0o755);
};

/**
 * Every path under `root` except Git's own, sorted. An argument the binary refuses must leave this
 * identical: the claim worth pinning is that nothing was written, which only the filesystem can
 * answer — an exit code says nothing about a tree that was already mutated (#86).
 */
const tree = (root: string): string[] => {
	const paths: string[] = [];
	const walk = (relativePath: string): void => {
		for (const entry of readdirSync(join(root, relativePath), {withFileTypes: true})) {
			if (entry.name === ".git") continue;
			const child = relativePath ? `${relativePath}/${entry.name}` : entry.name;
			paths.push(child);
			// False for a symlink, so managed links are recorded without being followed.
			if (entry.isDirectory()) walk(child);
		}
	};
	walk("");
	return paths.sort();
};

const command = (cwd: string, args: string[], path: string) =>
	spawnSync(join(cwd, ".pipeline/toolkit/bin/pipeline"), args, {
		cwd,
		encoding: "utf8",
		env: {...process.env, PATH: `${path}:${process.env.PATH}`},
	});

const toolkitFixture = (): {root: string; toolkit: string; mockBin: string} => {
	const root = mkdtempSync(join(tmpdir(), "pipeline-init-"));
	roots.push(root);
	const toolkit = join(root, "toolkit-source");
	const mockBin = join(root, "mock-bin");
	mkdirSync(mockBin, {recursive: true});
	write(join(toolkit, "package.json"), '{"name":"fixture-toolkit","private":true,"type":"module"}\n');
	write(join(toolkit, "bin/pipeline"), "#!/usr/bin/env bash\nexec node --experimental-strip-types \"$(dirname \"$0\")/../packages/pipeline/src/bin.ts\" \"$@\"\n", true);
	mkdirSync(join(toolkit, "packages/pipeline/src"), {recursive: true});
	copyFileSync(join(process.cwd(), "src/bin.ts"), join(toolkit, "packages/pipeline/src/bin.ts"));
	copyFileSync(join(process.cwd(), "src/payload.ts"), join(toolkit, "packages/pipeline/src/payload.ts"));
	write(join(toolkit, "packages/pipeline-cli/src/bin.ts"), 'import {appendFileSync} from "node:fs";\nappendFileSync(new URL("../../../bin/pipeline.calls", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\nprocess.exit(Number(process.env.PIPELINE_CLI_STATUS ?? 0));\n');
	write(join(toolkit, "packages/pipeline-crew-mcp/src/bin.ts"), "export {};\n");
	write(join(toolkit, "claude-plugins/pipeline-crew/crew.config.template.jsonc"), '{"operator":"<operator-name>"}\n');
	write(join(toolkit, "templates/glossary/LANGUAGE.md"), "# Fixture language\n");
	write(join(toolkit, "templates/glossary/TERMS.md"), "# Fixture terms\n");
	write(join(toolkit, "templates/docs/CLAUDE.md"), "# Fixture guidance\n");
	write(join(toolkit, "templates/decisions/README.md"), "# Fixture decisions\n");
	write(join(toolkit, "templates/patterns/index.md"), "# Fixture patterns\n");
		write(join(toolkit, "templates/pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{}}\n');
		write(join(toolkit, "templates/pipeline/optional-workflow-policy.json"), '{"schemaVersion":1,"workflows":{}}\n');
		write(join(toolkit, "templates/pipeline/cli-capability-matrix.md"), "# Fixture capability matrix\n");
	write(join(toolkit, "templates/github/workflows/pipeline-verify.yml"), "name: Fixture verify\n");
	write(join(toolkit, "templates/github/workflows/pipeline-doc-safety.yml"), "name: Fixture docs\n");
	write(join(toolkit, "templates/github/workflows/pipeline-delivery-gate.yml"), "name: Fixture delivery gate\n");
	write(join(toolkit, "templates/github/workflows/pipeline-gitleaks.yml"), "name: Fixture Gitleaks\n");
	write(join(toolkit, "templates/github/workflows/pipeline-doc-links.yml"), "name: Fixture doc links\n");
	write(join(toolkit, "templates/github/workflows/pipeline-settings-env-guard.yml"), "name: Fixture settings env\n");
	write(join(toolkit, "templates/github/workflows/pipeline-unresolved-threads.yml"), "name: Fixture unresolved threads\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/example/SKILL.md"), "# Example\n");
	for (const name of CORE_SKILL_NAMES) write(join(toolkit, `claude-plugins/kampus-pipeline/skills/${name}/SKILL.md`), `# ${name}\n`);
	for (const name of CORE_WORKFLOW_SUPPORT_FILES) write(join(toolkit, `claude-plugins/kampus-pipeline/skills/${name}`), `# ${name}\n`);
	copyFileSync(join(process.cwd(), "../../claude-plugins/kampus-pipeline/workflow-catalog.json"), join(toolkit, "claude-plugins/kampus-pipeline/workflow-catalog.json"));
	for (const name of ["adr", "canon", "coder", "planner", "reporter", "reviewer", "shipper", "triager"]) {
		write(join(toolkit, `claude-plugins/kampus-pipeline/agents/${name}.md`), `# ${name}\n`);
	}
	for (const name of ["install.sh", "guard.sh", "resolve-toolkit-root.sh"]) {
		const destination = join(toolkit, "claude-plugins/kampus-pipeline/hooks", name);
		mkdirSync(join(destination, ".."), {recursive: true});
		copyFileSync(join(process.cwd(), "../../claude-plugins/kampus-pipeline/hooks", name), destination);
		chmodSync(destination, 0o755);
	}
	for (const name of ["pnpm", "claude"]) write(join(mockBin, name), "#!/usr/bin/env bash\nexit 0\n", true);
	for (const name of ["gh", "tmux"]) write(join(mockBin, name), "#!/usr/bin/env bash\nexit 97\n", true);
	execFileSync("git", ["init", "-q"], {cwd: toolkit});
	execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {cwd: toolkit});
	execFileSync("git", ["config", "user.name", "fixture"], {cwd: toolkit});
	execFileSync("git", ["add", "."], {cwd: toolkit});
	execFileSync("git", ["commit", "-qm", "toolkit"], {cwd: toolkit});
	return {root, toolkit, mockBin};
};

const fixture = (): {consumer: string; mockBin: string} => {
	const {root, toolkit, mockBin} = toolkitFixture();
	const consumer = join(root, "consumer");
	mkdirSync(consumer);
	execFileSync("git", ["init", "-q"], {cwd: consumer});
	execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {cwd: consumer});
	execFileSync("git", ["config", "user.name", "fixture"], {cwd: consumer});
	write(join(consumer, "README.md"), "# Consumer\n");
	write(join(consumer, ".claude/settings.json"), '{"custom":true}\n');
	execFileSync("git", ["add", "."], {cwd: consumer});
	execFileSync("git", ["commit", "-qm", "base"], {cwd: consumer});
	execFileSync("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", toolkit, ".pipeline/toolkit"], {cwd: consumer});
	execFileSync("git", ["commit", "-qam", "submodule"], {cwd: consumer});
	return {consumer, mockBin};
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

const enabledPrimaryIndexGuardPolicy = JSON.stringify({
	schemaVersion: 1,
	github: {},
	git: {
		primaryIndexGuard: {
			enabled: true,
			protectedPathPrefixes: ["protected"],
			blockThreshold: 2,
			attribution: {enabled: false, threshold: 1, logPath: null},
		},
	},
});

describe("pipeline init", () => {
	// The trailing timeout below is 90s of headroom, not a 90s test: measured, this runs in about
	// 14s, and adding `pipeline-verify` to the payload did not change that. It is slow because it
	// drives real `git` through two full installs per fixture, and it once crossed the old 20s limit
	// while sharing the machine with this package's other test file. The margin absorbs that
	// variance. It is not covering a regression, and the assertion is unchanged.
	it("creates project-local wiring, preserves settings, and is idempotent", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(JSON.parse(readFileSync(join(consumer, ".claude/settings.json"), "utf8"))).toMatchObject({custom: true, hooks: expect.any(Object)});
		expect(JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"))).toMatchObject({
			private: true,
			scripts: {pipeline: "./.pipeline/toolkit/bin/pipeline"},
		});
		expect(existsSync(join(consumer, ".pipeline/pipeline.json"))).toBe(true);
		expect(readFileSync(join(consumer, ".glossary/LANGUAGE.md"), "utf8")).toBe("# Fixture language\n");
		expect(readFileSync(join(consumer, "CLAUDE.md"), "utf8")).toBe("# Fixture guidance\n");
		expect(readFileSync(join(consumer, ".decisions/README.md"), "utf8")).toBe("# Fixture decisions\n");
		expect(readFileSync(join(consumer, ".patterns/index.md"), "utf8")).toBe("# Fixture patterns\n");
		expect(readFileSync(join(consumer, ".pipeline/agent-policy.json"), "utf8")).toBe('{"schemaVersion":1,"github":{}}\n');
		expect(readFileSync(join(consumer, ".pipeline/optional-workflow-policy.json"), "utf8")).toBe('{"schemaVersion":1,"workflows":{}}\n');
		expect(readFileSync(join(consumer, ".pipeline/cli-capability-matrix.md"), "utf8")).toBe("# Fixture capability matrix\n");
		expect(lstatSync(join(consumer, ".pipeline/workflow-catalog.json")).isSymbolicLink()).toBe(true);
		const initialStatus = command(consumer, ["status", "--json"], mockBin);
		expect(initialStatus.status).toBe(0);
		expect(JSON.parse(initialStatus.stdout)).toMatchObject({ok: true, catalogue: "current", policy: "valid"});
		expect(readFileSync(join(consumer, ".claude/crew.config.jsonc"), "utf8")).toBe('{"operator":"<operator-name>"}\n');
		expect(readFileSync(join(consumer, ".gitignore"), "utf8")).toContain(".claude/crew.config.jsonc\n");
		expect(command(consumer, ["init"], mockBin).stderr).toContain("fill every placeholder in .claude/crew.config.jsonc before running pipeline crew stand-up");
		// No CI workflow is installed unless the repository asked for it (#32). Writing seven into
		// an adopter made their first pull request red over checks about the toolkit, and `ship-it`
		// then correctly refused to merge anything.
		expect(existsSync(join(consumer, ".github/workflows/pipeline-delivery-gate.yml"))).toBe(false);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-gitleaks.yml"))).toBe(false);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-doc-links.yml"))).toBe(false);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-settings-env-guard.yml"))).toBe(false);
		// pipeline-verify is opt-in like the rest, even though ship-it cannot pass without it — a
		// required check nobody chose is still a required check nobody chose.
		expect(existsSync(join(consumer, ".github/workflows/pipeline-verify.yml"))).toBe(false);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-unresolved-threads.yml"))).toBe(false);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-doc-safety.yml"))).toBe(false);
		expect(existsSync(join(consumer, "claude-plugins/kampus-pipeline"))).toBe(false);
		expect(existsSync(join(consumer, "claude-plugins/pipeline-crew"))).toBe(false);
		for (const agent of CORE_AGENT_NAMES) expect(existsSync(join(consumer, ".claude/agents", `${agent}.md`))).toBe(true);
		expect(lstatSync(join(consumer, ".claude/agents/reviewer.md")).isSymbolicLink()).toBe(true);
		for (const skill of CORE_SKILL_NAMES) expect(existsSync(join(consumer, ".claude/skills", skill))).toBe(true);
		for (const file of CORE_WORKFLOW_SUPPORT_FILES) expect(existsSync(join(consumer, ".claude/skills", file))).toBe(true);
		// The opt-in half: a workflow the repository ENABLES is written. Without this the previous
		// assertions would pass just as well if the feature had been deleted rather than gated.
		writeFileSync(
			join(consumer, ".pipeline/optional-workflow-policy.json"),
			'{"schemaVersion":1,"workflows":{"pipeline-gitleaks":{"enabled":true}}}\n',
		);
		expect(command(consumer, ["sync"], mockBin).status).toBe(0);
		expect(readFileSync(join(consumer, ".github/workflows/pipeline-gitleaks.yml"), "utf8")).toBe("name: Fixture Gitleaks\n");
		expect(existsSync(join(consumer, ".github/workflows/pipeline-doc-links.yml"))).toBe(false);
		// `enable` now operates on the workflows, the only optional thing left in the payload (#34).
		expect(command(consumer, ["enable", "pipeline-doc-links"], mockBin).status).toBe(0);
		expect(readFileSync(join(consumer, ".github/workflows/pipeline-doc-links.yml"), "utf8")).toBe("name: Fixture doc links\n");
		expect(JSON.parse(readFileSync(join(consumer, ".pipeline/optional-workflow-policy.json"), "utf8"))).toMatchObject({
			workflows: {"pipeline-doc-links": {enabled: true}},
		});
		expect(JSON.parse(command(consumer, ["status", "--json"], mockBin).stdout).optional).toContainEqual(
			expect.objectContaining({name: "pipeline-doc-links", state: "installed"}),
		);
		// A skill that no longer exists cannot be enabled — the old product skills are gone.
		expect(command(consumer, ["enable", "release"], mockBin).status).not.toBe(0);
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		expect(command(consumer, ["enable", "not-a-workflow"], mockBin).status).toBe(1);
		expect(readFileSync(join(consumer, ".glossary/TERMS.md"), "utf8")).toBe("# Fixture terms\n");
		const settingsPath = join(consumer, ".claude/settings.json");
		const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {hooks: Record<string, unknown[]>};
		expect(JSON.stringify(settings.hooks)).toContain("$CLAUDE_PROJECT_DIR/.pipeline/toolkit/claude-plugins/kampus-pipeline/hooks/");
		expect(JSON.stringify(settings.hooks)).not.toContain("$CLAUDE_PROJECT_DIR/claude-plugins/kampus-pipeline/hooks/");
		settings.hooks.SessionStart?.push({
			matcher: "startup|resume",
			hooks: [{type: "command", command: "old/claude-plugins/kampus-pipeline/hooks/guard.sh worktree-sweep --execute"}],
		});
		writeFileSync(settingsPath, `${JSON.stringify(settings)}\n`);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(readFileSync(settingsPath, "utf8")).not.toContain("worktree-sweep");
		const legacyPath = join(consumer, "claude-plugins/kampus-pipeline");
		mkdirSync(join(legacyPath, ".."), {recursive: true});
		symlinkSync("../.pipeline/toolkit/claude-plugins/kampus-pipeline", legacyPath, "dir");
		const configPath = join(consumer, ".pipeline/pipeline.json");
		const config = JSON.parse(readFileSync(configPath, "utf8")) as {managedPaths: Array<{path: string; target: string}>};
		config.managedPaths.push({path: "claude-plugins/kampus-pipeline", target: "../.pipeline/toolkit/claude-plugins/kampus-pipeline"});
		writeFileSync(configPath, `${JSON.stringify(config)}\n`);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(existsSync(legacyPath)).toBe(false);
		write(join(consumer, ".glossary/LANGUAGE.md"), "# Consumer language\n");
		write(join(consumer, "CLAUDE.md"), "# Consumer guidance\n");
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"issueMutation":true}}\n');
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(readFileSync(join(consumer, ".glossary/LANGUAGE.md"), "utf8")).toBe("# Consumer language\n");
		expect(readFileSync(join(consumer, "CLAUDE.md"), "utf8")).toBe("# Consumer guidance\n");
		expect(readFileSync(join(consumer, ".pipeline/agent-policy.json"), "utf8")).toBe('{"schemaVersion":1,"github":{"issueMutation":true}}\n');
		write(join(consumer, ".github/workflows/adopter-owned.yml"), "name: Consumer workflow\n");
		expect(command(consumer, ["sync"], mockBin).status).toBe(0);
		expect(readFileSync(join(consumer, ".github/workflows/adopter-owned.yml"), "utf8")).toBe("name: Consumer workflow\n");
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/skills/deslop-comments"), {recursive: true});
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		const driftStatus = command(consumer, ["status", "--json"], mockBin);
		expect(driftStatus.status).toBe(1);
		expect(JSON.parse(driftStatus.stdout).core).toContainEqual(expect.objectContaining({name: "deslop-comments", state: "missing-or-drifted"}));
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/skills/report"), {recursive: true});
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/agents/reporter.md"), {recursive: true});
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".patterns/index.md"));
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), "{not-json}\n");
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"guardContent":{"enabled":false,"decisionRecordPaths":[],"vocabularyPatterns":[]}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"guardContent":{"enabled":true,"decisionRecordPaths":["^records/.*\\\\.md$"],"vocabularyPatterns":["safeguard|approval"]}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"guardContent":{"enabled":true,"decisionRecordPaths":[],"vocabularyPatterns":["safeguard"]}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"guardContent":{"enabled":false,"decisionRecordPaths":["^records/"],"vocabularyPatterns":[]}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"protectedChangeApproval":{"authority":{"provider":"github-team","organization":null,"teamSlug":null},"requiredNonAuthorApprovals":1,"soleAuthorException":{"enabled":false,"commentPattern":null}}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"protectedChangeApproval":{"authority":{"provider":"github-team","organization":null,"teamSlug":"delivery-approvers"},"requiredNonAuthorApprovals":2,"soleAuthorException":{"enabled":true,"commentPattern":"^sole approval @ [0-9a-f]+$"}}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"protectedChangeApproval":{"authority":{"provider":"github-team","organization":null,"teamSlug":"delivery-approvers"},"requiredNonAuthorApprovals":0,"soleAuthorException":{"enabled":false,"commentPattern":null}}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{"shipping":{"protectedChangeApproval":{"authority":{"provider":"github-team","organization":null,"teamSlug":"delivery-approvers"},"requiredNonAuthorApprovals":1,"soleAuthorException":{"enabled":true,"commentPattern":"["}}}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{}}\n');
		write(join(consumer, ".pipeline/optional-workflow-policy.json"), "{not-json}\n");
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		// A policy naming nothing installable leaves the previously-enabled workflow on disk, and
		// `check` is right to red on that drift — `sync` is what reconciles it, by uninstalling.
		write(join(consumer, ".pipeline/optional-workflow-policy.json"), '{"schemaVersion":1,"workflows":{"release":{"enabled":true}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		expect(command(consumer, ["sync"], mockBin).status).toBe(0);
		expect(existsSync(join(consumer, ".github/workflows/pipeline-doc-links.yml"))).toBe(false);
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
	}, 90_000);

	it("refuses an unmanaged conflict unless force replaces a prior managed path", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/skills/deslop-comments"), {recursive: true});
		write(join(consumer, ".claude/skills/deslop-comments"), "user content\n");
		expect(command(consumer, ["init"], mockBin).status).toBe(1);
		expect(command(consumer, ["init", "--force"], mockBin).status).toBe(0);
		expect(existsSync(join(consumer, ".claude/skills/deslop-comments"))).toBe(true);
	});

	it("retires a link whose artifact left the payload, but never one the adopter replaced", () => {
		// Dropping a skill from the payload used to strand its link: the adopter updates the toolkit,
		// the directory it points at disappears, and a dangling entry sits in `.claude/skills/`
		// failing by not matching rather than by erroring. Deleting two skills is what surfaced it.
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		const gone = join(consumer, ".claude/skills/deslop-comments");
		const kept = join(consumer, ".claude/skills/diataxis");
		expect(lstatSync(gone).isSymbolicLink()).toBe(true);

		// Simulate the submodule moving to a toolkit where both skills were deleted.
		for (const name of ["deslop-comments", "diataxis"]) {
			rmSync(join(consumer, ".pipeline/toolkit/claude-plugins/kampus-pipeline/skills", name), {
				recursive: true,
				force: true,
			});
		}
		// The adopter has since put their own file where one of them was. It is theirs now.
		rmSync(kept, {recursive: true, force: true});
		write(kept, "adopter content\n");

		const result = command(consumer, ["init"], mockBin);
		expect(existsSync(gone)).toBe(false);
		expect(result.stderr).toContain("retired");
		expect(readFileSync(kept, "utf8")).toBe("adopter content\n");
	});

	it("preserves an adopter-owned workflow catalogue conflict", () => {
		const {consumer, mockBin} = fixture();
		write(join(consumer, ".pipeline/workflow-catalog.json"), "adopter catalogue\n");
		const result = command(consumer, ["init"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("refusing to replace existing .pipeline/workflow-catalog.json");
		expect(readFileSync(join(consumer, ".pipeline/workflow-catalog.json"), "utf8")).toBe("adopter catalogue\n");
	});

	// Self-hosting: in the toolkit repository itself, `.pipeline/toolkit` is a symlink back to the
	// repository root. A repository cannot be its own submodule, so the pinning probe is the one
	// assertion init must skip there; everything else is the full consumer payload.
	it("initializes the toolkit repository itself when .pipeline/toolkit points back at its root", () => {
		const {toolkit, mockBin} = toolkitFixture();
		mkdirSync(join(toolkit, ".pipeline"));
		// The target resolves relative to `.pipeline/`, so the repository root is `..`, not `../..`.
		symlinkSync("..", join(toolkit, ".pipeline/toolkit"), "dir");
		expect(command(toolkit, ["init"], mockBin).status).toBe(0);
		expect(existsSync(join(toolkit, ".pipeline/pipeline.json"))).toBe(true);
		// Managed links keep the consumer-shaped lexical target and resolve through both hops:
		// .claude/... -> ../../.pipeline/toolkit/... -> the live tree.
		const reviewer = join(toolkit, ".claude/agents/reviewer.md");
		expect(lstatSync(reviewer).isSymbolicLink()).toBe(true);
		expect(readlinkSync(reviewer)).toBe("../../.pipeline/toolkit/claude-plugins/kampus-pipeline/agents/reviewer.md");
		expect(readFileSync(reviewer, "utf8")).toBe("# reviewer\n");
		for (const skill of CORE_SKILL_NAMES) expect(existsSync(join(toolkit, ".claude/skills", skill))).toBe(true);
		for (const file of CORE_WORKFLOW_SUPPORT_FILES) expect(existsSync(join(toolkit, ".claude/skills", file))).toBe(true);
		expect(readFileSync(join(toolkit, "CLAUDE.md"), "utf8")).toBe("# Fixture guidance\n");
		// `cli` forwarding resolved the real tree through the symlink: init's ref-guard install
		// reached the stub pipeline-cli, which logs beside the real bin/pipeline.
		expect(readFileSync(join(toolkit, "bin/pipeline.calls"), "utf8")).toContain("ref-guard install");
		// A consumer-shaped workflow in this repository would test a checkout of itself (#26).
		for (const name of ["pipeline-verify", "pipeline-doc-safety", "pipeline-delivery-gate", "pipeline-gitleaks", "pipeline-doc-links", "pipeline-settings-env-guard", "pipeline-unresolved-threads"]) {
			expect(existsSync(join(toolkit, `.github/workflows/${name}.yml`))).toBe(false);
		}
		expect(command(toolkit, ["init", "--check"], mockBin).status).toBe(0);
		expect(JSON.parse(command(toolkit, ["status", "--json"], mockBin).stdout)).toMatchObject({ok: true});
		// `enable` refuses before touching the policy, so nothing is queued for a later `sync`.
		const enable = command(toolkit, ["enable", "pipeline-gitleaks"], mockBin);
		expect(enable.status).toBe(1);
		expect(enable.stderr).toContain("this repository hosts the toolkit itself");
		expect(existsSync(join(toolkit, ".github/workflows/pipeline-gitleaks.yml"))).toBe(false);
		expect(readFileSync(join(toolkit, ".pipeline/optional-workflow-policy.json"), "utf8")).toBe('{"schemaVersion":1,"workflows":{}}\n');
		expect(command(toolkit, ["init", "--check"], mockBin).status).toBe(0);
		// The policy file is plain JSON, and hand-edit-then-`sync` is the supported flow exercised
		// above for consumers — so the refusal must guard the materialization site, not just `enable`.
		writeFileSync(
			join(toolkit, ".pipeline/optional-workflow-policy.json"),
			'{"schemaVersion":1,"workflows":{"pipeline-gitleaks":{"enabled":true}}}\n',
		);
		const sync = command(toolkit, ["sync"], mockBin);
		expect(sync.status).toBe(1);
		expect(sync.stderr).toContain("this repository hosts the toolkit itself");
		expect(existsSync(join(toolkit, ".github/workflows/pipeline-gitleaks.yml"))).toBe(false);
		// And `check` reds on the enabled flag itself: the state cannot sit green while violating #26.
		const checkResult = command(toolkit, ["init", "--check"], mockBin);
		expect(checkResult.status).toBe(1);
		expect(checkResult.stderr).toContain("consumer-shaped workflow is enabled in the self-hosted toolkit repository: pipeline-gitleaks");
		writeFileSync(join(toolkit, ".pipeline/optional-workflow-policy.json"), '{"schemaVersion":1,"workflows":{}}\n');
		expect(command(toolkit, ["init", "--check"], mockBin).status).toBe(0);
	}, 30_000);

	it("still refuses a toolkit directory that is neither a submodule nor the repository itself", () => {
		const {root, toolkit, mockBin} = toolkitFixture();
		const consumer = join(root, "consumer");
		mkdirSync(consumer);
		execFileSync("git", ["init", "-q"], {cwd: consumer});
		execFileSync("git", ["config", "user.email", "fixture@example.invalid"], {cwd: consumer});
		execFileSync("git", ["config", "user.name", "fixture"], {cwd: consumer});
		write(join(consumer, "README.md"), "# Consumer\n");
		execFileSync("git", ["add", "."], {cwd: consumer});
		execFileSync("git", ["commit", "-qm", "base"], {cwd: consumer});
		// A plain copy passes every structural existence check while being neither pinned nor the
		// repository itself — the self-host seam must not have widened what the probe accepts.
		cpSync(toolkit, join(consumer, ".pipeline/toolkit"), {recursive: true, filter: (source) => basename(source) !== ".git"});
		const result = command(consumer, ["init"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(".pipeline/toolkit must be an initialized Git submodule");
		// A symlink that resolves somewhere OTHER than the repository root is the discriminating
		// case: symlink-ness alone must not select the self-host seam — only a toolkit that IS the
		// project root does — or any adopter could unpin with `ln -s ../../some-checkout`.
		rmSync(join(consumer, ".pipeline/toolkit"), {recursive: true, force: true});
		symlinkSync(join("..", "..", "toolkit-source"), join(consumer, ".pipeline/toolkit"), "dir");
		const linked = command(consumer, ["init"], mockBin);
		expect(linked.status).toBe(1);
		expect(linked.stderr).toContain(".pipeline/toolkit must be an initialized Git submodule");
	}, 20_000);

	it("refuses to treat a consumer's pinned checkout as self-hosted even with the self symlink present", () => {
		const {consumer, mockBin} = fixture();
		// Committing the self symlink ships it inside every pin, where it points at the pin's own
		// root — realpath equality alone cannot tell that apart from the toolkit repository. Running
		// init from inside the pin must stay a hard failure, not a payload written into the pinned
		// tree; the superproject probe is what discriminates.
		const pin = join(consumer, ".pipeline/toolkit");
		mkdirSync(join(pin, ".pipeline"));
		symlinkSync("..", join(pin, ".pipeline/toolkit"), "dir");
		const result = command(pin, ["init"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(".pipeline/toolkit must be an initialized Git submodule");
	}, 20_000);

	it("installs an explicit shared pre-commit wrapper and blocks only exit 3", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), `${enabledPrimaryIndexGuardPolicy}\n`);
		expect(command(consumer, ["primary-index-guard", "check-hook"], mockBin).status).toBe(1);
		expect(command(consumer, ["primary-index-guard", "install-hook"], mockBin).status).toBe(0);
		const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {cwd: consumer, encoding: "utf8"}).trim();
		const hook = join(commonDir, "hooks/pre-commit");
		expect(readFileSync(hook, "utf8")).toContain("kampus-pipeline primary-index-guard managed hook");
		expect(lstatSync(hook).mode & 0o111).not.toBe(0);
		expect(command(consumer, ["primary-index-guard", "check-hook"], mockBin).status).toBe(0);
		for (const [cliStatus, expectedHookStatus] of [["0", 0], ["3", 1], ["2", 0]] as const) {
			const result = spawnSync(hook, [], {
				cwd: consumer,
				encoding: "utf8",
				env: {...process.env, PATH: `${mockBin}:${process.env.PATH}`, PIPELINE_CLI_STATUS: cliStatus},
			});
			expect(result.status).toBe(expectedHookStatus);
		}
		expect(readFileSync(join(consumer, ".pipeline/toolkit/bin/pipeline.calls"), "utf8")).toContain("primary-index-guard pre-commit");
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
		expect(JSON.parse(command(consumer, ["status", "--json"], mockBin).stdout).core).toContainEqual(expect.objectContaining({name: "primary-index-guard", type: "git-hook", state: "installed"}));
	}, 20_000);

	it("preserves an unrelated pre-commit hook and rejects invalid enabled policy", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		write(join(consumer, ".pipeline/agent-policy.json"), `${enabledPrimaryIndexGuardPolicy}\n`);
		const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {cwd: consumer, encoding: "utf8"}).trim();
		const hook = join(commonDir, "hooks/pre-commit");
		write(hook, "#!/usr/bin/env sh\necho adopter hook\n", true);
		const install = command(consumer, ["primary-index-guard", "install-hook"], mockBin);
		expect(install.status).toBe(1);
		expect(install.stderr).toContain("refusing to overwrite an unrelated pre-commit hook");
		expect(readFileSync(hook, "utf8")).toBe("#!/usr/bin/env sh\necho adopter hook\n");
		write(join(consumer, ".pipeline/agent-policy.json"), '{"schemaVersion":1,"github":{},"git":{"primaryIndexGuard":{"enabled":true,"protectedPathPrefixes":[],"blockThreshold":2}}}\n');
		expect(command(consumer, ["primary-index-guard", "check-hook"], mockBin).status).toBe(1);
	}, 20_000);

	// The crew launcher only uses a multiplexer as a window manager, but a missing binary still fails the
	// whole stand-up — so `check` verifies the terminal the crew config actually selects. It is scoped to
	// a PERSONALIZED config on purpose: a repo that never stands a crew up must not be made to install
	// tmux to pass, which is also what keeps CI (where the git-ignored crew config is absent) unaffected.
	const personalizeCrew = (consumer: string, config: Record<string, unknown>): void =>
		write(join(consumer, ".claude/crew.config.jsonc"), `${JSON.stringify(config)}\n`);

	// These assert on the presence/absence of the terminal diagnostic rather than the exit status, so
	// they stay meaningful independently of whatever else the fixture's `check` reports.
	const TERMINAL_DIAGNOSTIC = "crew terminal";

	it("check accepts a personalized crew config whose terminal is installed", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// Flag-faithful like the real binary: herdr answers `--version`; anything else is a miss,
		// so this test also pins herdr's entry in the version-probe map.
		write(join(mockBin, "herdr"), '#!/usr/bin/env bash\n[ "$1" = "--version" ] || exit 1\nexit 0\n', true);
		personalizeCrew(consumer, {operator: "op", terminal: "herdr"});
		expect(command(consumer, ["check"], mockBin).stderr).not.toContain(TERMINAL_DIAGNOSTIC);
	}, 20_000);

	it("check tolerates the absent operator-owned crew config in a fresh clone or worktree", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// The crew config is materialized AND git-ignored by init — the one managed path a fresh
		// clone or linked worktree legitimately lacks. Its absence is the not-yet-personalized
		// state, never repository drift (#68).
		rmSync(join(consumer, ".claude/crew.config.jsonc"));
		const result = command(consumer, ["check"], mockBin);
		expect(result.stderr).not.toContain("missing managed path: .claude/crew.config.jsonc");
		expect(result.status).toBe(0);
	}, 20_000);

	it("check probes tmux with the flag tmux actually answers", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// Flag-faithful stub: like the real binary, tmux answers `-V` and rejects `--version` —
		// a blanket exit-0 stub is exactly what let the generic `--version` probe report the
		// DEFAULT terminal as missing on every machine that had it.
		write(join(mockBin, "tmux"), '#!/usr/bin/env bash\n[ "$1" = "-V" ] || exit 1\nexit 0\n', true);
		personalizeCrew(consumer, {operator: "op", terminal: "tmux"});
		expect(command(consumer, ["check"], mockBin).stderr).not.toContain(TERMINAL_DIAGNOSTIC);
	}, 20_000);

	it("check reports the configured crew terminal when its binary is absent", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// mockBin is PREPENDED to PATH, so a stub that exits non-zero shadows any really-installed herdr
		// and makes the missing-binary branch deterministic on any machine.
		write(join(mockBin, "herdr"), "#!/usr/bin/env bash\nexit 1\n", true);
		personalizeCrew(consumer, {operator: "op", terminal: "herdr"});
		const result = command(consumer, ["check"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("missing required command for the configured crew terminal: herdr");
	}, 20_000);

	it("check rejects a crew terminal outside the supported vocabulary", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		personalizeCrew(consumer, {operator: "op", terminal: "screen"});
		const result = command(consumer, ["check"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("unsupported crew terminal in .claude/crew.config.jsonc: screen");
	}, 20_000);

	it("check reads the terminal past the template's surrounding comments", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// The shipped template documents the dimension in prose directly above the key, naming both
		// backends — a naive match would read the comment instead of the value.
		write(
			join(consumer, ".claude/crew.config.jsonc"),
			'{\n\t// Which terminal: "tmux" (the default) or "herdr".\n\t"operator": "op",\n\t"terminal": "screen"\n}\n',
		);
		expect(command(consumer, ["check"], mockBin).stderr).toContain("unsupported crew terminal in .claude/crew.config.jsonc: screen");
	}, 20_000);

	it("check skips the terminal while the crew config is still unpersonalized", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		// An unfilled config carries `<placeholders>`; init already tells the operator to fill it, and a
		// crew that was never set up must not fail the install contract on a terminal it will never use.
		personalizeCrew(consumer, {operator: "<operator-name>", terminal: "screen"});
		expect(command(consumer, ["check"], mockBin).stderr).not.toContain(TERMINAL_DIAGNOSTIC);
	}, 20_000);

	// The two argument-policy tests below are one bug (#86) seen from both sides: `--help` is a real
	// verb that writes nothing, and anything unrecognised is refused instead of discarded. They run
	// against a consumer where `init` WOULD succeed, so an ignored argument shows up as a full
	// install rather than as an unrelated failure.
	const ARGUMENT_POLICY_SUBCOMMANDS = ["init", "sync", "check", "status", "enable", "primary-index-guard"] as const;

	it("init --help writes nothing", () => {
		const {consumer, mockBin} = fixture();
		const before = tree(consumer);
		const settings = readFileSync(join(consumer, ".claude/settings.json"), "utf8");
		const result = command(consumer, ["init", "--help"], mockBin);
		// Filesystem first, deliberately: the bug exited 0 after a COMPLETE install, so an
		// exit-code assertion passed while the adopter's tree was being rewritten.
		expect(tree(consumer)).toEqual(before);
		expect(readFileSync(join(consumer, ".claude/settings.json"), "utf8")).toBe(settings);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("usage: pipeline init");
		expect(command(consumer, ["init", "-h"], mockBin).status).toBe(0);
		expect(tree(consumer)).toEqual(before);
	}, 20_000);

	it("prints usage for --help in every subcommand", () => {
		const {consumer, mockBin} = fixture();
		for (const subcommand of ARGUMENT_POLICY_SUBCOMMANDS) {
			const result = command(consumer, [subcommand, "--help"], mockBin);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain(`usage: pipeline ${subcommand}`);
		}
		// `check` read its project root out of `args[0]`, so `--help` was a directory to resolve.
		expect(command(consumer, ["check", "--help"], mockBin).stderr).not.toContain("check failed");
		const topLevel = command(consumer, ["--help"], mockBin);
		expect(topLevel.status).toBe(0);
		expect(topLevel.stdout).toContain("usage: pipeline <init|sync|check|status|enable|primary-index-guard|cli|crew>");
	}, 20_000);

	it("refuses an unrecognized argument in every subcommand, naming it", () => {
		const {consumer, mockBin} = fixture();
		const before = tree(consumer);
		const invocations = [
			["init", "--nope"],
			["sync", "--nope"],
			["check", "--nope"],
			["status", "--nope"],
			["enable", "--nope"],
			["primary-index-guard", "--nope"],
			// A stray operand is unrecognised too: the hole was the discarded argument, not the dash.
			["status", "nope"],
		];
		for (const invocation of invocations) {
			const result = command(consumer, invocation, mockBin);
			// An ignored argument is only dangerous because the command proceeded anyway.
			expect(tree(consumer)).toEqual(before);
			// Exit 1 is `packages/pipeline-cli`'s status for a usage error, not a per-site invention.
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`unrecognized argument for '${invocation[0]}': ${invocation[1]}`);
			expect(result.stderr).toContain(`usage: pipeline ${invocation[0]}`);
		}
	}, 20_000);

	it("requires a CLI tool name", () => {
	const result = spawnSync(join(process.cwd(), "../../bin/pipeline"), ["cli"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("CLI tool is required");
	});

	it("dispatches generated hooks through the local toolkit binary", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		const result = spawnSync(join(consumer, ".pipeline/toolkit/claude-plugins/kampus-pipeline/hooks/guard.sh"), ["worktree-guard", "pre-file"], {
			cwd: consumer,
			encoding: "utf8",
			input: "{}\n",
			env: {...process.env, CLAUDE_PROJECT_DIR: consumer},
		});
		expect(result.status).toBe(0);
		expect(readFileSync(join(consumer, ".pipeline/toolkit/bin/pipeline.calls"), "utf8")).toContain("worktree-guard pre-file");
	});
});
