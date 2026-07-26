import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

const run = (root: string, args: ReadonlyArray<string>, input = ""): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> =>
	new Promise((resolve) => {
		const child = execFile("node", [BIN, "class-probe", "classify", "--root", root, ...args], (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
		child.stdin?.end(input);
	});

describe("class-probe command", () => {
	let root: string;
	let paths: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "class-probe-command-"));
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {review: {classification: {
			code: {includePatterns: ["^src/"], excludePatterns: []},
			docs: {includePatterns: ["\\.md$"], excludePatterns: ["^skills/"]},
			skills: {includePatterns: ["^skills/"], excludePatterns: []},
			design: {includePatterns: ["^src/ui/"], excludePatterns: []},
		}}}}), "utf8");
		paths = join(root, "changed-files");
		writeFileSync(paths, "src/ui/Panel.tsx\nskills/review/SKILL.md\n", "utf8");
	});

	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("prints stable review namespaces on stdout and diagnostics on stderr", async () => {
		const result = await run(root, ["--files-from", paths, "--namespaces"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["review-code", "review-skill", "review-design"]);
		expect(result.stderr).toContain("policy trusted");
	});

	it("classifies an unreadable policy source conservatively", async () => {
		const result = await run(root, ["--policy-ref", "does-not-exist", "--files-from", paths, "--namespaces"]);
		expect(result.code, result.stderr).toBe(0);
		expect(result.stdout.trim().split("\n")).toEqual(["review-code", "review-doc", "review-skill", "review-design"]);
		expect(result.stderr).toContain("fail-closed");
	});
});
