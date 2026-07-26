import {execFile} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));

interface RunResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

const run = (args: ReadonlyArray<string>): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile("node", [BIN, "ship-digest", ...args], (error, stdout, stderr) => {
			const code = error && typeof (error as {code?: unknown}).code === "number"
				? (error as {code: number}).code
				: 0;
			resolve({code, stdout, stderr});
		});
	});

describe("ship-digest derive CLI", () => {
	let dir: string;
	const write = (name: string, content: string): string => {
		const path = join(dir, name);
		writeFileSync(path, content, "utf8");
		return path;
	};

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ship-digest-"));
	});
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it("renders canonical entries with repository-provided labels", async () => {
		const root = join(dir, "repo");
		mkdirSync(join(root, ".pipeline"), {recursive: true});
		writeFileSync(join(root, ".pipeline", "agent-policy.json"), JSON.stringify({
			schemaVersion: 1,
			github: {shipping: {shipDigest: {
				categories: {order: ["customer", "platform"], labels: {customer: "Customer-facing", platform: "Platform"}, fallbackLabel: "Uncategorized"},
				types: {order: ["feature", "maintenance"], labels: {feature: "Features", maintenance: "Maintenance"}, fallbackLabel: "Uncategorized"},
			}}},
		}), "utf8");
		const entries = write("entries.json", JSON.stringify([
			{issue: 1, pr: 2, title: "Add dashboard", type: "feature", milestone: "Beta", category: "customer", releaseState: "live"},
			{pr: 4, title: "Improve runner", type: "maintenance", category: "platform", releaseState: "dark"},
		]));
		const result = await run(["derive", "--entries", entries, "--since", "2026-06-01", "--until", "2026-07-01", "--root", root]);
		assert.strictEqual(result.code, 0);
		assert.include(result.stdout, "# Ship digest — 2026-06-01 → 2026-07-01");
		assert.include(result.stdout, "## Customer-facing");
		assert.include(result.stdout, "#### Features");
		assert.include(result.stdout, "- Add dashboard (#2) — live");
		assert.include(result.stdout, "## Needs release attention");
		assert.include(result.stdout, "- Improve runner (#4)");
	}, 30_000);

	it("accepts temporary aliases, gives canonical keys precedence, and reports the migration", async () => {
		const entries = write("aliases.json", JSON.stringify([
			{pr: 9, title: "Alias-compatible work", type: "feature", category: "customer", area: "platform", joinedArea: "platform"},
		]));
		const result = await run(["derive", "--entries", entries, "--since", "2026-06-01", "--until", "2026-07-01"]);
		assert.strictEqual(result.code, 0);
		assert.include(result.stdout, "## customer");
		assert.include(result.stderr, "deprecated area/joinedArea aliases were normalized");
	}, 30_000);

	it("writes only the body to --out, retaining stdout as a clean channel", async () => {
		const entries = write("out-entries.json", JSON.stringify([{pr: 10, title: "Write report", category: "customer", type: "feature"}]));
		const out = join(dir, "DIGEST.md");
		const result = await run(["derive", "--entries", entries, "--since", "2026-06-01", "--out", out]);
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stdout, "");
		assert.include(readFileSync(out, "utf8"), "# Ship digest —");
		assert.include(result.stderr, "ship-digest: wrote 1 entr(y/ies)");
	}, 30_000);

	it("fails non-zero for unreadable or schema-invalid entry files", async () => {
		const unreadable = await run(["derive", "--entries", join(dir, "missing.json"), "--since", "2026-06-01"]);
		assert.notStrictEqual(unreadable.code, 0);
		const invalid = write("invalid.json", JSON.stringify([{pr: 0, title: "invalid"}]));
		const malformed = await run(["derive", "--entries", invalid, "--since", "2026-06-01"]);
		assert.notStrictEqual(malformed.code, 0);
	}, 30_000);
});
