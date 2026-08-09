/**
 * The skill-payload reference checks, against fixtures AND against this repository's own tree.
 *
 * The tree assertions are the ones that keep the guard honest — same posture as
 * `evals-placement.test.ts`: `pnpm -r test` is a CI step, so asserting the real tree here is what
 * "runs in CI" means for a payload property. They are not the whole story for this guard, though,
 * because `.github/workflows/ci.yml` also invokes the script directly; the test at the bottom is
 * what stops that step from being dropped and leaving the checks unwired again (#167).
 */
import {spawnSync} from "node:child_process";
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, assert, describe, expect, it} from "vitest";

const repoRoot = join(process.cwd(), "../..");
const scriptPath = "claude-plugins/kampus-pipeline/skills/validate-skills.sh";
const script = join(repoRoot, scriptPath);

type Run = {status: number | null; stdout: string; stderr: string};

/**
 * The baseline path is always passed explicitly for fixtures. Left to its default the script
 * derives it from `git rev-parse`, so a fixture built under a `TMPDIR` that happens to sit inside a
 * checkout would read — and `--write-baseline` would overwrite — this repository's real baseline.
 */
const run = (skills: string, baseline: string, args: string[] = []): Run => {
	const result = spawnSync(join(skills, "validate-skills.sh"), args, {
		encoding: "utf8",
		env: {...process.env, VALIDATE_SKILLS_BASELINE: baseline},
	});
	return {status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
};

describe("validate-skills reference checks", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) rmSync(scratch, {recursive: true, force: true});
		scratch = null;
	});

	/**
	 * A miniature skill tree. Two of its three markdown files are unreachable from the per-directory
	 * `SKILL.md` glob the frontmatter checks use — one sits at the tree root, one under `shared/`,
	 * which has no `SKILL.md` at all. That is the traversal gap the reference checks exist to close,
	 * so the fixture carries it rather than testing a shape the payload does not have.
	 */
	const build = (): {skills: string; baseline: string} => {
		scratch = mkdtempSync(join(tmpdir(), "validate-skills-"));
		const skills = join(scratch, "skills");
		mkdirSync(join(skills, "alpha"), {recursive: true});
		mkdirSync(join(skills, "shared"), {recursive: true});
		copyFileSync(script, join(skills, "validate-skills.sh"));
		chmodSync(join(skills, "validate-skills.sh"), 0o755);
		writeFileSync(
			join(skills, "alpha/SKILL.md"),
			"---\nname: alpha\ndescription: A fixture skill.\n---\n\n## A heading\n\nSee [the contract](../root-contract.md#a-target-heading) and [back](#a-heading).\n",
		);
		writeFileSync(join(skills, "root-contract.md"), "# Root contract\n\n## A target heading\n\nText.\n");
		writeFileSync(join(skills, "shared/contract.md"), "# Shared contract\n\n## Shared heading\n\nText.\n");
		return {skills, baseline: join(scratch, "baseline.tsv")};
	};

	const damage = (skills: string, file: string, text: string): void =>
		writeFileSync(join(skills, file), `${readFileSync(join(skills, file), "utf8")}\n${text}\n`);

	it("passes a clean tree with no baseline at all", () => {
		const {skills, baseline} = build();
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
		expect(result.stdout).toContain("scanned 3 markdown file(s)");
	});

	it("fails a link target that is prose rather than a path", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "See [the rule](the applicable safety invariant).");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("alpha/SKILL.md");
		expect(result.stdout).toContain("prose-href: link target is prose, not a path");
	});

	it("fails a fragment that matches no heading, with the target file intact", () => {
		// The check that earns its keep. Substitution destroys the fragment and leaves the path
		// alone, so a link check that stops at file existence passes this exact damage.
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "See [the contract](../root-contract.md#a-heading-that-was-renamed).");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("anchor: link fragment matches no heading");
	});

	it("fails a fragment whose target document does not exist", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "See [gone](../no-such-file.md#somewhere).");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("anchor: link fragment unresolvable: target document does not exist");
	});

	it("fails text-substitution residue outside any link", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "This follows repository precedent.");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("phrase: text-substitution residue (repository precedent)");
	});

	it("walks markdown the frontmatter glob cannot reach — the tree root and `shared/`", () => {
		const {skills, baseline} = build();
		damage(skills, "root-contract.md", "This follows repository precedent.");
		damage(skills, "shared/contract.md", "See [the rule](repository-owned record URL).");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("root-contract.md");
		expect(result.stdout).toContain("shared/contract.md");
	});

	it("resolves an anchor whose heading is shadowed by a `#` comment inside a fenced block", () => {
		// Fenced lines are not headings, and skipping them is not merely cosmetic: a bogus heading
		// shifts the duplicate-slug suffix of every heading after it, so real anchors stop resolving.
		const {skills, baseline} = build();
		writeFileSync(
			join(skills, "root-contract.md"),
			"# Root contract\n\n```bash\n# A target heading\n```\n\n## A target heading\n\nText.\n",
		);
		assert.strictEqual(run(skills, baseline).status, 0);
	});

	it("reads a document once, however many same-document fragments it carries", () => {
		// Regression: indexing headings lazily during the scan shared one `getline < file` position
		// with the scan itself, so a same-document `#fragment` re-read the file from the top —
		// doubling occurrence counts and reporting the second pass's line numbers.
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "See [back](#a-heading) again, then repository precedent once.");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("occurrences by check: prose-href=0 anchor=0 phrase=1");
		expect(result.stdout).not.toContain("occurrences in this file");
	});

	it("suppresses exactly what the baseline lists and still fails anything new", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "This follows repository precedent.");
		assert.strictEqual(run(skills, baseline, ["--write-baseline"]).status, 0);
		assert.strictEqual(run(skills, baseline).status, 0);

		damage(skills, "shared/contract.md", "See [the rule](the applicable safety invariant).");
		const ratchet = run(skills, baseline);
		assert.strictEqual(ratchet.status, 1, ratchet.stdout);
		expect(ratchet.stdout).toContain("shared/contract.md");
		expect(ratchet.stdout).not.toContain("FAIL alpha/SKILL.md");
	});

	it("keys the baseline per finding, so a repair in one file cannot cover a new one in another", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "This follows repository precedent.");
		run(skills, baseline, ["--write-baseline"]);
		writeFileSync(join(skills, "alpha/SKILL.md"), readFileSync(join(skills, "alpha/SKILL.md"), "utf8").replace("This follows repository precedent.", ""));
		damage(skills, "shared/contract.md", "This follows repository precedent.");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1, result.stdout);
		expect(result.stdout).toContain("FAIL shared/contract.md");
		expect(result.stdout).toContain("RESOLVED alpha/SKILL.md");
	});

	it("reports a baselined finding that no longer reproduces, and does not fail on it", () => {
		// #116/#117 draw this baseline down. If repairing an entry reddened the build, the first
		// repair pull request would be the argument for deleting the ratchet.
		const {skills, baseline} = build();
		damage(skills, "shared/contract.md", "This follows repository precedent.");
		run(skills, baseline, ["--write-baseline"]);
		writeFileSync(join(skills, "shared/contract.md"), "# Shared contract\n\n## Shared heading\n\nText.\n");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 0, result.stdout);
		expect(result.stdout).toContain("RESOLVED shared/contract.md");
		expect(result.stdout).toContain("1 baseline entry resolved");
	});

	it("treats a baselined finding whose whole file was deleted as resolved, not as failure", () => {
		// A file this baseline covers can leave the tree entirely under concurrent work. Resolution
		// has to hold for a deleted document, not only for a repaired line.
		const {skills, baseline} = build();
		damage(skills, "shared/contract.md", "This follows repository precedent.");
		run(skills, baseline, ["--write-baseline"]);
		unlinkSync(join(skills, "shared/contract.md"));
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 0, result.stdout);
		expect(result.stdout).toContain("RESOLVED shared/contract.md");
	});

	it("suppresses nothing when the baseline file is absent — absence is not `skip the check`", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "This follows repository precedent.");
		run(skills, baseline, ["--write-baseline"]);
		assert.strictEqual(run(skills, baseline).status, 0);
		unlinkSync(baseline);
		assert.strictEqual(run(skills, baseline).status, 1);
	});

	it("never writes the baseline on an ordinary run", () => {
		const {skills, baseline} = build();
		damage(skills, "alpha/SKILL.md", "This follows repository precedent.");
		run(skills, baseline, ["--write-baseline"]);
		const written = readFileSync(baseline, "utf8");
		damage(skills, "shared/contract.md", "This follows repository precedent.");
		run(skills, baseline);
		assert.strictEqual(readFileSync(baseline, "utf8"), written);
	});

	it("rejects an unknown argument rather than silently checking nothing", () => {
		const {skills, baseline} = build();
		const result = run(skills, baseline, ["--regenerate"]);
		assert.strictEqual(result.status, 2);
		expect(result.stderr).toContain("unknown argument");
	});
});

describe("validate-skills frontmatter checks", () => {
	let scratch: string | null = null;
	afterEach(() => {
		if (scratch !== null) rmSync(scratch, {recursive: true, force: true});
		scratch = null;
	});

	const build = (): {skills: string; baseline: string} => {
		scratch = mkdtempSync(join(tmpdir(), "validate-skills-fm-"));
		const skills = join(scratch, "skills");
		mkdirSync(join(skills, "alpha"), {recursive: true});
		copyFileSync(script, join(skills, "validate-skills.sh"));
		chmodSync(join(skills, "validate-skills.sh"), 0o755);
		writeFileSync(join(skills, "alpha/SKILL.md"), "---\nname: alpha\ndescription: A fixture skill.\n---\n\nText.\n");
		return {skills, baseline: join(scratch, "baseline.tsv")};
	};

	it("still fails a name that does not match its directory", () => {
		const {skills, baseline} = build();
		writeFileSync(join(skills, "alpha/SKILL.md"), "---\nname: beta\ndescription: A fixture skill.\n---\n");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("name 'beta' does not match directory 'alpha'");
	});

	it("still fails an empty description", () => {
		const {skills, baseline} = build();
		writeFileSync(join(skills, "alpha/SKILL.md"), "---\nname: alpha\ndescription:\n---\n");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 1);
		expect(result.stdout).toContain("frontmatter missing non-empty 'description'");
	});

	it("leaves markdown outside `*/SKILL.md` unchecked for frontmatter", () => {
		// The wider walk belongs to the reference checks only. A contract document has no `name` to
		// match a directory, so extending the frontmatter contract to it would be a different change.
		const {skills, baseline} = build();
		writeFileSync(join(skills, "contract.md"), "No frontmatter here at all.\n");
		const result = run(skills, baseline);
		assert.strictEqual(result.status, 0, result.stdout);
		expect(result.stdout).toContain("scanned 2 markdown file(s)");
	});
});

describe("validate-skills against this repository", () => {
	const tree = (args: string[]): Run => {
		const result = spawnSync(script, args, {encoding: "utf8"});
		return {status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? ""};
	};

	it("exits 0 on the tree as it stands, with the checked-in baseline", () => {
		const result = tree([]);
		assert.strictEqual(result.status, 0, result.stdout + result.stderr);
	});

	it("walks the shared contract at the tree root and the documents under `shared/`", () => {
		// Both are invisible to `*/SKILL.md`, and the one at the root carries more reference damage
		// than any other file in the payload.
		const files = tree(["--list-files"]).stdout.split("\n");
		expect(files).toContain("claude-plugins/kampus-pipeline/skills/gh-issue-intake-formats.md");
		expect(files.some((file) => file.startsWith("claude-plugins/kampus-pipeline/skills/shared/"))).toBe(true);
	});

	it("is invoked by the build job, so the checks are wired to a signal", () => {
		const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
		expect(workflow).toContain(scriptPath);
	});

	it("hardcodes no repository, host or absolute path", () => {
		// The plugin is installed into other repositories. A check that knows this repository's
		// answers is a check that fails in the next one.
		const source = readFileSync(script, "utf8");
		for (const literal of ["github.com", "https://", "/Users/", "/home/", "$HOME"]) {
			expect(source, literal).not.toContain(literal);
		}
		expect(source.match(/\bgit [a-z-]+/g) ?? []).toEqual(["git rev-parse"]);
	});

	it("keeps every baseline entry repository-relative and free of counts", () => {
		const baseline = readFileSync(join(repoRoot, ".pipeline/validate-skills-baseline.tsv"), "utf8");
		const entries = baseline.split("\n").filter((line) => line !== "" && !line.startsWith("#"));
		expect(entries.length).toBeGreaterThan(0);
		for (const entry of entries) {
			const [check, file] = entry.split("\t");
			expect(entry.split("\t")).toHaveLength(3);
			expect(["prose-href", "anchor", "phrase"]).toContain(check);
			expect(file?.startsWith("/")).toBe(false);
			expect(file?.startsWith("claude-plugins/")).toBe(true);
		}
	});
});
