#!/usr/bin/env node
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {renderWorkflowCatalog} from "./payload.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const destination = resolve(root, "claude-plugins/kampus-pipeline/workflow-catalog.json");
const expected = renderWorkflowCatalog();

if (process.argv.includes("--check")) {
	if (!existsSync(destination) || readFileSync(destination, "utf8") !== expected) {
		process.stderr.write("workflow catalogue is out of date; run `pnpm --dir packages/pipeline generate:workflow-catalog`\n");
		process.exit(1);
	}
	process.stdout.write("workflow catalogue is current\n");
} else {
	writeFileSync(destination, expected);
	process.stdout.write(`wrote ${destination}\n`);
}
