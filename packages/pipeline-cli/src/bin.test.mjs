import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import test from "node:test";

const run = (...args) => spawnSync(process.execPath, ["src/bin.mjs", ...args], {encoding: "utf8"});

test("reports its private generic version", () => {
	const result = run("version");
	assert.equal(result.status, 0);
	assert.match(result.stdout, /pipeline-cli/);
});

test("rejects nonportable tools", () => {
	const result = run("release");
	assert.equal(result.status, 1);
});
