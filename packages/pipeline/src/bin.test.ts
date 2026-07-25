import {execFileSync, spawnSync} from "node:child_process";
import {chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, describe, expect, it} from "vitest";

const roots: string[] = [];

const write = (path: string, text: string, executable = false): void => {
	mkdirSync(join(path, ".."), {recursive: true});
	writeFileSync(path, text);
	if (executable) chmodSync(path, 0o755);
};

const command = (cwd: string, args: string[], path: string) =>
	spawnSync(process.execPath, [join(process.cwd(), "src/bin.ts"), ...args], {
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
	write(join(toolkit, "package.json"), '{"name":"fixture-toolkit","private":true}\n');
	write(join(toolkit, "bin/pipeline"), "#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$(dirname \"$0\")/pipeline.calls\"\nexit 0\n", true);
	write(join(toolkit, "packages/pipeline-cli/src/bin.ts"), "export {};\n");
	write(join(toolkit, "packages/pipeline-crew-mcp/src/bin.ts"), "export {};\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/example/SKILL.md"), "# Example\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/report/SKILL.md"), "# Report\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/triage/SKILL.md"), "# Triage\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/skills/release/SKILL.md"), "# Release\n");
	write(join(toolkit, "claude-plugins/kampus-pipeline/agents/reviewer.md"), "# Reviewer\n");
	write(join(toolkit, "claude-plugins/pipeline-crew/agents/crew-chief-of-staff.md"), "# Chief\n");
	write(join(toolkit, "claude-plugins/pipeline-crew/commands/stand-up.md"), "# Stand up\n");
	write(join(toolkit, "claude-plugins/pipeline-crew/crew.config.template.jsonc"), '{"value":"<placeholder>"}\n');
	for (const name of ["install.sh", "guard.sh", "resolve-toolkit-root.sh"]) {
		const destination = join(toolkit, "claude-plugins/kampus-pipeline/hooks", name);
		mkdirSync(join(destination, ".."), {recursive: true});
		copyFileSync(join(process.cwd(), "../../claude-plugins/kampus-pipeline/hooks", name), destination);
		chmodSync(destination, 0o755);
	}
	for (const name of ["pnpm", "claude", "gh", "tmux"]) write(join(mockBin, name), "#!/usr/bin/env bash\nexit 0\n", true);
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
		expect(existsSync(join(consumer, ".pipeline/pipeline.json"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/skills/example"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/skills/report"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/skills/triage"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/skills/release"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/agents/reviewer.md"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/agents/crew-chief-of-staff.md"))).toBe(true);
		expect(existsSync(join(consumer, ".claude/commands/stand-up.md"))).toBe(true);
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(1);
		write(join(consumer, ".claude/crew.config.jsonc"), '{"value":"configured"}\n');
		expect(command(consumer, ["init", "--check"], mockBin).status).toBe(0);
	});

	it("refuses an unmanaged conflict unless force replaces a prior managed path", () => {
		const {consumer, mockBin} = fixture();
		expect(command(consumer, ["init"], mockBin).status).toBe(0);
		rmSync(join(consumer, ".claude/commands/stand-up.md"), {recursive: true});
		write(join(consumer, ".claude/commands/stand-up.md"), "user content\n");
		expect(command(consumer, ["init"], mockBin).status).toBe(1);
		expect(command(consumer, ["init", "--force"], mockBin).status).toBe(0);
		expect(existsSync(join(consumer, ".claude/commands/stand-up.md"))).toBe(true);
	});

	it("requires a CLI tool name", () => {
		const result = spawnSync(process.execPath, [join(process.cwd(), "src/bin.ts"), "cli"], {
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
		expect(readFileSync(join(consumer, ".pipeline/toolkit/bin/pipeline.calls"), "utf8")).toContain("cli worktree-guard pre-file");
	});
});
