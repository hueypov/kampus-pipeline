import {execFileSync, spawnSync} from "node:child_process";
import {chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";
import {ARCHIVED_SKILL_NAMES, CORE_AGENT_NAMES, CORE_SKILL_NAMES, CORE_WORKFLOW_SUPPORT_FILES} from "./payload.ts";

const roots: string[] = [];

const write = (path: string, text: string, executable = false): void => {
	mkdirSync(join(path, ".."), {recursive: true});
	writeFileSync(path, text);
	if (executable) chmodSync(path, 0o755);
};

const command = (cwd: string, args: string[], path: string) =>
	spawnSync(join(cwd, ".pipeline/toolkit/bin/pipeline"), args, {
		cwd,
		encoding: "utf8",
		env: {...process.env, PATH: `${path}:${process.env.PATH}`},
	});

const fixture = (): {consumer: string; mockBin: string} => {
	const root = mkdtempSync(join(tmpdir(), "pipeline-init-"));
	roots.push(root);
	const toolkit = join(root, "toolkit-source");
	const consumer = join(root, "consumer");
	const mockBin = join(root, "mock-bin");
	mkdirSync(mockBin, {recursive: true});
	write(join(toolkit, "package.json"), '{"name":"fixture-toolkit","private":true,"type":"module"}\n');
	write(join(toolkit, "bin/pipeline"), "#!/usr/bin/env bash\nexec node --experimental-strip-types \"$(dirname \"$0\")/../packages/pipeline/src/bin.ts\" \"$@\"\n", true);
	mkdirSync(join(toolkit, "packages/pipeline/src"), {recursive: true});
	copyFileSync(join(process.cwd(), "src/bin.ts"), join(toolkit, "packages/pipeline/src/bin.ts"));
	copyFileSync(join(process.cwd(), "src/payload.ts"), join(toolkit, "packages/pipeline/src/payload.ts"));
	write(join(toolkit, "packages/pipeline-cli/src/bin.ts"), 'import {appendFileSync} from "node:fs";\nappendFileSync(new URL("../../../bin/pipeline.calls", import.meta.url), process.argv.slice(2).join(" ") + "\\n");\n');
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
	write(join(toolkit, "templates/github/workflows/pipeline-toolkit.yml"), "name: Fixture toolkit\n");
	write(join(toolkit, "templates/github/workflows/pipeline-doc-safety.yml"), "name: Fixture docs\n");
	write(join(toolkit, "templates/github/workflows/pipeline-delivery-gate.yml"), "name: Fixture delivery gate\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/example/SKILL.md"), "# Example\n");
	for (const name of CORE_SKILL_NAMES) write(join(toolkit, `claude-plugins/kampus-pipeline/skills/${name}/SKILL.md`), `# ${name}\n`);
	for (const name of CORE_WORKFLOW_SUPPORT_FILES) write(join(toolkit, `claude-plugins/kampus-pipeline/skills/${name}`), `# ${name}\n`);
	for (const name of ARCHIVED_SKILL_NAMES) write(join(toolkit, `claude-plugins/kampus-pipeline/skills/${name}/SKILL.md`), `# ${name}\n`);
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

describe("pipeline init", () => {
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
		expect(readFileSync(join(consumer, ".github/workflows/pipeline-toolkit.yml"), "utf8")).toBe("name: Fixture toolkit\n");
		expect(readFileSync(join(consumer, ".github/workflows/pipeline-delivery-gate.yml"), "utf8")).toBe("name: Fixture delivery gate\n");
		expect(existsSync(join(consumer, "claude-plugins/kampus-pipeline"))).toBe(false);
		expect(existsSync(join(consumer, "claude-plugins/pipeline-crew"))).toBe(false);
		for (const agent of CORE_AGENT_NAMES) expect(existsSync(join(consumer, ".claude/agents", `${agent}.md`))).toBe(true);
		expect(lstatSync(join(consumer, ".claude/agents/reviewer.md")).isSymbolicLink()).toBe(true);
		for (const skill of CORE_SKILL_NAMES) expect(existsSync(join(consumer, ".claude/skills", skill))).toBe(true);
		for (const file of CORE_WORKFLOW_SUPPORT_FILES) expect(existsSync(join(consumer, ".claude/skills", file))).toBe(true);
		expect(existsSync(join(consumer, ".claude/skills/release"))).toBe(false);
		expect(command(consumer, ["enable", "release"], mockBin).status).toBe(0);
		expect(existsSync(join(consumer, ".claude/skills/release"))).toBe(true);
		expect(lstatSync(join(consumer, ".claude/skills/release")).isSymbolicLink()).toBe(true);
		expect(JSON.parse(readFileSync(join(consumer, ".pipeline/optional-workflow-policy.json"), "utf8"))).toMatchObject({
			workflows: {release: {enabled: true}},
		});
		expect(JSON.parse(command(consumer, ["status", "--json"], mockBin).stdout).optional).toContainEqual(expect.objectContaining({name: "release", state: "enabled-adapter-required"}));
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
		write(join(consumer, ".github/workflows/pipeline-toolkit.yml"), "name: Consumer workflow\n");
		expect(command(consumer, ["sync"], mockBin).status).toBe(0);
		expect(readFileSync(join(consumer, ".github/workflows/pipeline-toolkit.yml"), "utf8")).toBe("name: Consumer workflow\n");
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
		write(join(consumer, ".pipeline/optional-workflow-policy.json"), "{not-json}\n");
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".pipeline/optional-workflow-policy.json"), '{"schemaVersion":1,"workflows":{"release":{"enabled":true}}}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
	}, 20_000);

	it("refuses an unmanaged conflict unless force replaces a prior managed path", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/skills/deslop-comments"), {recursive: true});
		write(join(consumer, ".claude/skills/deslop-comments"), "user content\n");
		expect(command(consumer, ["init"], mockBin).status).toBe(1);
		expect(command(consumer, ["init", "--force"], mockBin).status).toBe(0);
		expect(existsSync(join(consumer, ".claude/skills/deslop-comments"))).toBe(true);
	});

	it("preserves an adopter-owned workflow catalogue conflict", () => {
		const {consumer, mockBin} = fixture();
		write(join(consumer, ".pipeline/workflow-catalog.json"), "adopter catalogue\n");
		const result = command(consumer, ["init"], mockBin);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("refusing to replace existing .pipeline/workflow-catalog.json");
		expect(readFileSync(join(consumer, ".pipeline/workflow-catalog.json"), "utf8")).toBe("adopter catalogue\n");
	});

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
