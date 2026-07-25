import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

const run = (args, options = {}) => spawnSync(process.execPath, ["src/bin.mjs", ...args], {encoding: "utf8", ...options});

test("reports its private generic version", () => {
	const result = run(["version"]);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /pipeline-cli/);
});

test("rejects nonportable tools", () => {
	const result = run(["release"]);
	assert.equal(result.status, 1);
});

test("streams a generic issue body to gh without applying a project label", () => {
	const root = mkdtempSync(join(tmpdir(), "pipeline-cli-test-"));
	try {
		const gh = join(root, "gh");
		const argsPath = join(root, "args");
		const bodyPath = join(root, "body");
		writeFileSync(gh, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "$TEST_ARGS"\ncat > "$TEST_BODY"\nprintf '%s\\n' 'https://github.com/example/repo/issues/42'\n`);
		chmodSync(gh, 0o755);
		const result = run(["tracker", "create-issue", "--title", "Follow up"], {
			input: "## Summary\nObserved\n",
			env: {...process.env, PATH: `${root}:${process.env.PATH}`, TEST_ARGS: argsPath, TEST_BODY: bodyPath},
		});
		assert.equal(result.status, 0);
		assert.match(readFileSync(argsPath, "utf8"), /issue create --title Follow up --body-file -/);
		assert.doesNotMatch(readFileSync(argsPath, "utf8"), /--label/);
		assert.equal(readFileSync(bodyPath, "utf8"), "## Summary\nObserved\n");
	} finally {
		rmSync(root, {recursive: true, force: true});
	}
});
