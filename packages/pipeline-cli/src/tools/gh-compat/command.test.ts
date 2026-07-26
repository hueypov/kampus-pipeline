import {execFile} from "node:child_process";
import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const SHIM = fileURLToPath(new URL("./shim-bin.ts", import.meta.url));

const run = (args: ReadonlyArray<string>): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> =>
	new Promise((resolve) => {
		execFile("node", [BIN, ...args], (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
	});

const runShim = (args: ReadonlyArray<string>, cwd: string): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> =>
	new Promise((resolve) => {
		execFile("node", [SHIM, ...args], {cwd, env: {...process.env, PIPELINE_GH_COMPAT_ROOT: cwd}}, (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
	});

describe("gh-compat command surface", () => {
	let root: string;
	let skill: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "gh-compat-command-"));
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		mkdirSync(join(root, "skills", "sample"), {recursive: true});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({
			schemaVersion: 1,
			github: {cliCompatibility: {enabled: false, targetRepository: null, realGhPath: null, pathShim: {enabled: false}, graphql: {mode: "passthrough", blockVerbs: [], unsupportedJsonFields: [], rewriteIssueAndPrEdit: false}, skillLint: {strictYamlFrontmatter: true, forbidConfiguredGraphqlPaths: false, selfExemptPaths: []}}},
		}), "utf8");
		skill = join(root, "skills", "sample", "SKILL.md");
		writeFileSync(skill, ["---", "name: sample", 'description: "a valid: skill"', "---", "", "use gh api repos/o/r/issues/1"].join("\n"), "utf8");
	});

	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("preserves the clean canonical lint contract", async () => {
		const canonical = await run(["gh-compat", "lint-skills", "--root", root, skill]);
		expect(canonical.code).toBe(0);
		expect(canonical.stdout).toContain("clean");
	});

	it("fails closed on zero scope", async () => {
		const result = await run(["gh-compat", "lint-skills", "--root", root, join(root, "missing.md")]);
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("zero required files");
	});

	it("runs a configured REST rewrite through the explicit shim without changing PATH", async () => {
		const shimRoot = mkdtempSync(join(tmpdir(), "gh-compat-shim-"));
		try {
			const fakeGh = join(shimRoot, "real-gh");
			writeFileSync(fakeGh, '#!/usr/bin/env sh\nprintf "FAKE_GH %s\\n" "$*"\n', "utf8");
			chmodSync(fakeGh, 0o755);
			mkdirSync(join(shimRoot, ".pipeline"), {recursive: true});
			writeFileSync(join(shimRoot, ".pipeline", "agent-policy.json"), JSON.stringify({
				schemaVersion: 1,
				github: {cliCompatibility: {enabled: true, targetRepository: "example-org/example-repo", realGhPath: fakeGh, pathShim: {enabled: true}, graphql: {mode: "rest-only", blockVerbs: ["project"], unsupportedJsonFields: ["projects"], rewriteIssueAndPrEdit: true}, skillLint: {strictYamlFrontmatter: true, forbidConfiguredGraphqlPaths: true, selfExemptPaths: []}}},
			}), "utf8");
			const result = await runShim(["pr", "edit", "42", "--body", "hello"], shimRoot);
			expect(result.code, `${result.stderr}\n${result.stdout}`).toBe(0);
			expect(result.stdout).toContain("FAKE_GH api -X PATCH repos/example-org/example-repo/issues/42 -f body=hello");
			expect(result.stderr).toContain("rewritten to the repository's configured REST PATCH path");
		} finally {
			rmSync(shimRoot, {recursive: true, force: true});
		}
	});
});
