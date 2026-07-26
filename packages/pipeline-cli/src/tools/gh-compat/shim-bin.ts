#!/usr/bin/env node

/**
 * Exact-argv gh compatibility shim. This stays outside Effect CLI parsing because a PATH shim
 * must preserve every gh flag verbatim, including flags after the verb. The registered
 * `gh-compat lint-skills` command remains the CI/local validation surface.
 */
import {spawnSync} from "node:child_process";
import {realpathSync} from "node:fs";
import {fileExists, resolveRealGh, resolveRepository} from "./resolve.ts";
import {readGhCompatibilityPolicy, repositoryRoot} from "./policy.ts";
import {routeGh} from "./router.ts";

const root = process.env.PIPELINE_GH_COMPAT_ROOT ?? repositoryRoot();
if (root === null) {
	process.stderr.write("gh-compat: not inside a Git repository; set PIPELINE_GH_COMPAT_ROOT for an explicit policy root.\n");
	process.exit(1);
}

const policy = readGhCompatibilityPolicy(root);
if (policy === null || !policy.enabled || !policy.pathShimEnabled) {
	process.stderr.write("gh-compat: the PATH shim is disabled or malformed. Set github.cliCompatibility.enabled and pathShim.enabled explicitly before activating it.\n");
	process.exit(1);
}

let self = process.argv[1] ?? "";
try { self = realpathSync(self); } catch { /* retain argv path */ }
const realGh = resolveRealGh(self, policy.realGhPath);
const repository = resolveRepository(realGh, policy.targetRepository);
const decision = routeGh(process.argv.slice(2), {policy, repo: repository, bodyFileExists: fileExists});

if (decision.kind === "block") {
	process.stderr.write(`gh-compat: blocked — ${decision.reason}\n  hint: ${decision.hint}\n`);
	process.exit(1);
}
if (realGh === null) {
	process.stderr.write("gh-compat: no real gh executable could be resolved. Set github.cliCompatibility.realGhPath or PIPELINE_REAL_GH.\n");
	process.exit(127);
}
if (decision.kind === "rewrite") {
	process.stderr.write(`gh-compat: ${decision.reason}\n`);
	if (decision.stripped.length) process.stderr.write(`gh-compat: removed unsupported configured fields: ${decision.stripped.join(", ")}\n`);
}
const result = spawnSync(realGh, [...decision.argv], {stdio: "inherit"});
process.exit(result.status ?? 1);
