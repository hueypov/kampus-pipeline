import {execFile, execFileSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, beforeAll, describe, expect, it} from "vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const run = (root: string, args: ReadonlyArray<string>): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "protected-change-policy", ...args, "--root", root], (error, stdout, stderr) => resolve({
			code: error && typeof (error as {code?: unknown}).code === "number" ? (error as {code: number}).code : 0,
			stdout,
			stderr,
		}));
	});

describe("protected-change-policy command", () => {
	let root: string;
	let paths: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "protected-change-policy-command-"));
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {shipping: {controlPlanePaths: ["^protected/"]}}}), "utf8");
		// These synchronous setup calls establish the immutable base policy used by the assertions.
		execFileSync("git", ["init", "-q"], {cwd: root});
		execFileSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
		execFileSync("git", ["config", "user.name", "Test"], {cwd: root});
		execFileSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
		execFileSync("git", ["commit", "-qm", "base policy"], {cwd: root});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({schemaVersion: 1, github: {shipping: {controlPlanePaths: ["^relaxed/"]}}}), "utf8");
		paths = join(root, "changed-files");
		writeFileSync(paths, "protected/config.yml\nordinary.md\n", "utf8");
	});

	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("uses the supplied immutable policy ref for regex and changed-path classification", async () => {
		const regex = await run(root, ["regex", "--policy-ref", "HEAD"]);
		expect(regex.code, regex.stderr).toBe(0);
		expect(regex.stdout.trim()).toBe("^((protected/))");
		const classified = await run(root, ["classify", "--policy-ref", "HEAD", "--files-from", paths]);
		expect(classified.code, classified.stderr).toBe(0);
		expect(classified.stdout.trim()).toBe("protected");
	});

	it("emits a shell-safe match-all fallback and fails non-zero when immutable policy cannot be read", async () => {
		const result = await run(root, ["regex", "--policy-ref", "does-not-exist"]);
		expect(result.code).toBe(2);
		expect(result.stdout.trim()).toBe(".");
	});
});
