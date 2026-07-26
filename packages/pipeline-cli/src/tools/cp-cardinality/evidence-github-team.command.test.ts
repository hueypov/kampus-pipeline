import {spawnSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
let root: string;
let fakeBin: string;

const policy = JSON.stringify({
	schemaVersion: 1,
	github: {shipping: {protectedChangeApproval: {
		authority: {provider: "github-team", organization: null, teamSlug: "delivery-approvers"},
		requiredNonAuthorApprovals: 1,
		soleAuthorException: {enabled: false, commentPattern: null},
	}}},
});

const run = (policyRef = "HEAD") => {
	const result = spawnSync("node", [BIN, "cp-cardinality", "evidence-github-team", "--root", root, "--policy-ref", policyRef, "--repo", "acme/widget", "--pr", "7"], {
		cwd: root,
		encoding: "utf8",
		env: {...process.env, PATH: `${fakeBin}:${process.env.PATH}`},
	});
	return {code: result.status ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

describe("cp-cardinality evidence-github-team command", () => {
	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "cp-evidence-"));
		fakeBin = join(root, "fake-bin");
		spawnSync("mkdir", ["-p", join(root, ".pipeline"), fakeBin]);
		spawnSync("git", ["init", "-q"], {cwd: root});
		spawnSync("git", ["config", "user.email", "test@example.invalid"], {cwd: root});
		spawnSync("git", ["config", "user.name", "Test"], {cwd: root});
		writeFileSync(join(root, ".pipeline/agent-policy.json"), policy, "utf8");
		spawnSync("git", ["add", ".pipeline/agent-policy.json"], {cwd: root});
		spawnSync("git", ["commit", "-qm", "base policy"], {cwd: root});
		writeFileSync(join(fakeBin, "gh"), `#!/bin/sh
case "$2" in
  orgs/acme/teams/delivery-approvers/members*) printf '%s' '[[{"login":"author"},{"login":"reviewer"}]]' ;;
  repos/acme/widget/pulls/7/reviews*) printf '%s' '[[{"id":1,"user":{"login":"reviewer"},"state":"APPROVED","commit_id":"head"}]]' ;;
  repos/acme/widget/pulls/7) printf '%s' '{"user":{"login":"author"},"head":{"sha":"head"}}' ;;
  *) exit 1 ;;
esac
`, {encoding: "utf8", mode: 0o755});
	});

	afterAll(() => rmSync(root, {recursive: true, force: true}));

	it("prints exactly one adapter-fact JSON object and no diagnostic on success", () => {
		const result = run();
		assert.strictEqual(result.code, 0);
		assert.strictEqual(result.stderr, "");
		assert.deepEqual(JSON.parse(result.stdout), {
			members: ["author", "reviewer"], author: "author", requiredNonAuthorApprovals: 1,
			nonAuthorApprovalsAtHead: 1, soleAuthorExceptionAtHead: false,
		});
	});

	it("does not fall back to a worktree or PR policy when the immutable policy ref is unavailable", () => {
		const result = run("missing-base-ref");
		assert.strictEqual(result.code, 1);
		assert.strictEqual(result.stdout, "");
		assert.include(result.stderr, "immutable policy ref");
	});
});
