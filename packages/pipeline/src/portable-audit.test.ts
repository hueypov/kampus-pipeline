import {readdirSync, readFileSync, statSync} from "node:fs";
import {join} from "node:path";
import {describe, expect, it} from "vitest";

const root = join(process.cwd(), "../..");
const portablePaths = [
	"bin/pipeline",
	"packages/pipeline/src/bin.ts",
	"templates/github/workflows",
	"claude-plugins/kampus-pipeline/hooks",
	"claude-plugins/pipeline-crew/agents",
	"claude-plugins/pipeline-crew/commands",
	"claude-plugins/pipeline-crew/crew.config.template.jsonc",
];
const forbidden = new RegExp(
	["pnpm dlx @kampus/pipeline-cli", "npm install @kampus/pipeline-cli", "publish .*pipeline-cli", "pho" + "enix", "cloud" + "flare", "cf-utils", "apps/web"].join("|"),
	"i",
);

const files = (path: string): string[] => {
	const absolute = join(root, path);
	if (!statSync(absolute).isDirectory()) return [absolute];
	return readdirSync(absolute, {withFileTypes: true}).flatMap((entry) =>
		files(join(path, entry.name)),
	);
};

describe("portable toolkit boundary", () => {
	it("contains no registry installer or project-specific policy in activated payloads", () => {
		const matches = portablePaths
			.flatMap(files)
			.flatMap((file) => {
				const match = readFileSync(file, "utf8").match(forbidden);
				return match ? [`${file}: ${match[0]}`] : [];
			});
		expect(matches).toEqual([]);
	});
});
