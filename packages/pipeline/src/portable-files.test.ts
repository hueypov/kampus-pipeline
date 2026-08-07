import {mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, relative} from "node:path";
import {beforeAll, describe, expect, it} from "vitest";
import {collectPayloadFiles} from "./portable-files.ts";

/**
 * Two trees: `repo`, standing in for the repository, and `outside`, standing in for the installed
 * toolkit cache the real hook links to. `outside` holds a string the audit would reject, so a walk
 * that escapes is caught by what it read, not only by where it went.
 */
let repo: string;
let outside: string;

const ESCAPED = "a-string-only-present-outside-the-repository";

beforeAll(() => {
	// realpath, because macOS hands out `/var/...` for a `/private/var/...` directory and every
	// assertion below is relative to the root the walk actually reports.
	const base = realpathSync(mkdtempSync(join(tmpdir(), "portable-files-")));
	repo = join(base, "repo");
	outside = join(base, "outside");

	mkdirSync(join(repo, "skills", "report"), {recursive: true});
	writeFileSync(join(repo, "skills", "report", "SKILL.md"), "clean\n");
	mkdirSync(join(repo, "skills", "shared"));
	writeFileSync(join(repo, "skills", "shared", "contract.md"), "clean\n");

	mkdirSync(join(outside, "skills"), {recursive: true});
	writeFileSync(join(outside, "skills", "SKILL.md"), `${ESCAPED}\n`);

	// Exactly the shape the toolkit's install hook plants: `.claude/.pipeline` beside a skill.
	mkdirSync(join(repo, "skills", "report", ".claude"));
	symlinkSync(outside, join(repo, "skills", "report", ".claude", ".pipeline"));
	// A link back into the repository — payload, not environment.
	symlinkSync(join(repo, "skills", "shared"), join(repo, "skills", "report", "shared"));
	// A link to nothing at all.
	symlinkSync(join(outside, "never-created"), join(repo, "skills", "report", "dangling"));
	// A cycle: without a visited set this walk would not terminate.
	symlinkSync(join(repo, "skills"), join(repo, "skills", "report", "loop"));
});

const found = (path: string) => collectPayloadFiles(repo, path).sort();
const asRelative = (path: string) => found(path).map((file) => relative(repo, file));

describe("collectPayloadFiles", () => {
	it("returns nothing from outside the repository", () => {
		// The defect this exists for: the walk read an installed copy of the toolkit through
		// `.claude/.pipeline` and reported its contents as this repository's (#36).
		expect(asRelative("skills/report").filter((file) => file.startsWith(".."))).toEqual([]);
	});

	it("never reads a byte that lives outside the repository", () => {
		// Stronger than the path check: it is the *content* the audit judges, so prove none of it
		// crossed over. A future walk that normalises paths but still opens the file fails here.
		const read = found("skills/report").map((file) => readFileSync(file, "utf8"));
		expect(read.filter((text) => text.includes(ESCAPED))).toEqual([]);
	});

	it("still reads the real files beside the escaping link", () => {
		// The fix must not be "skip the directory" — the payload in it still has to be audited.
		expect(asRelative("skills/report")).toContain(join("skills", "report", "SKILL.md"));
	});

	it("follows a link that resolves back inside the repository", () => {
		// Inside the root is payload however it is reached; only leaving is out of scope.
		expect(asRelative("skills/report")).toContain(join("skills", "shared", "contract.md"));
	});

	it("terminates on a link cycle and does not repeat a file", () => {
		const files = asRelative("skills/report");
		expect(new Set(files).size).toBe(files.length);
	});

	it("passes over a dangling link instead of throwing", () => {
		expect(() => found("skills/report")).not.toThrow();
	});

	it("reads a single file given directly", () => {
		expect(asRelative("skills/shared/contract.md")).toEqual([join("skills", "shared", "contract.md")]);
	});

	it("still throws on a path that is absent entirely", () => {
		// A manifest naming a path the tree lacks is a disagreement to surface, not an empty walk —
		// otherwise the audit passes by scanning nothing.
		expect(() => found("skills/never-written")).toThrow();
	});
});
