/**
 * Spawned-bin witnesses for the verdict-namespace guard — the tests the review proved the unit
 * suite cannot substitute for: the wiring's first version discarded the loader's trust flag and
 * fail-opened in every worktree while all 34 unit tests stayed green. Only a spawned process
 * running from a chosen root can witness which policy actually reached the guard.
 *
 * Unlike `verb-path.command.test.ts`, these need a live PR read (the guard consults the PR's
 * changed files and author), so they require an authenticated `gh` — and, since #53, an identity
 * that did not author the probe PR, because the split-role firewall refuses ahead of the namespace
 * check. Without both they SKIP, loudly, with the reason printed — a stated limitation, never a
 * silent pass: the pure seam (`guardPolicy`) is pinned unconditionally in the unit suite, and what
 * this file adds is the proof that the command actually routes through it.
 *
 * Probe safety: every body's first line is a non-marker, so a probe that passes the guard stops at
 * the marker check and nothing can ever land on the PR — the design the review used.
 */
import {execFile, execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO = "hueypov/kampus-pipeline";
/**
 * Merged PRs whose diffs classify to review-code alone, read-only — one authored by each identity
 * that runs this suite. The probe is chosen at run time as one the CALLER did not author, because
 * the split-role firewall runs ahead of the namespace check and would otherwise refuse first. This
 * file used to pass `--as spawned-test` and so never met the firewall at all; that a namespace test
 * could name itself a third party is the same defect #53 fixes, seen from the test side.
 */
const CANDIDATE_PRS = ["56", "70"] as const;

const readOut = (args: ReadonlyArray<string>): string => {
	try {
		return execFileSync("gh", args, {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
	} catch {
		return "";
	}
};

const ghAuthed = (): boolean => {
	try {
		execFileSync("gh", ["auth", "status"], {stdio: "ignore"});
		return true;
	} catch {
		return false;
	}
};

/** The authenticated login, and the first candidate PR it did not author — null when neither reads. */
const me = readOut(["api", "user", "--jq", ".login"]);
const probe =
	me === ""
		? null
		: (CANDIDATE_PRS.map((pr) => ({
				pr,
				author: readOut(["api", `repos/${REPO}/pulls/${pr}`, "--jq", ".user.login"]),
			})).find((c) => c.author !== "" && c.author.toLowerCase() !== me.toLowerCase()) ?? null);

interface RunResult {
	readonly code: number;
	readonly stderr: string;
}

const post = (cwd: string, gate: string, bodyFile: string): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "verdict", "post", "--pr", probe?.pr ?? "0", "--gate", gate, "--body-file", bodyFile],
			{cwd, env: {...process.env, CLAUDE_PIPELINE_REPO: REPO}},
			(error, _stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stderr});
			},
		);
	});

const authed = ghAuthed();
/** GitHub Actions and most CI set this; locally it is absent. */
const inCI = process.env.CI === "true" || process.env.CI === "1";

/**
 * A skip must not be able to masquerade as coverage.
 *
 * The first version printed its reason with `console.error` and skipped. Under vitest's DEFAULT
 * reporter — the one `pnpm -r test` and therefore CI runs — that reason is never displayed: the
 * output is `Tests 2 skipped (2)`, exit 0, and the guard's only wiring witnesses are silently
 * absent. Review caught the claim "skips loudly" being false exactly there.
 *
 * So the skip is local-only. In CI, being unable to run these is itself the defect: CI is where the
 * coverage is claimed, and a harness that cannot authenticate has removed a witness rather than
 * excused one.
 */
describe("verdict-namespace guard — the CI-coverage guard (#66)", () => {
	it.skipIf(probe !== null || !inCI)("CI must be able to run the live-PR probes", () => {
		assert.fail(
			`no usable probe in CI (gh authed: ${authed}, login: '${me}'), so the spawned namespace witnesses cannot run — set GH_TOKEN on the test step, and keep a candidate PR the CI identity did not author. A skip here would report coverage that does not exist.`,
		);
	});
});

if (probe === null) {
	// eslint-disable-next-line no-console
	console.error(
		`namespace.command.test: SKIPPED — ${me === "" ? "no readable gh identity" : `no candidate PR that '${me}' did not author`}, so the live-PR probes cannot run. The guardPolicy seam is still pinned by the unit suite.`,
	);
}

describe.skipIf(probe === null)("verdict-namespace guard — spawned witnesses (#66)", () => {
	let dir: string;
	let bodyFile: string;
	const repoRoot = fileURLToPath(new URL("../../../../..", import.meta.url));

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "ns-probe-"));
		bodyFile = join(dir, "nm.txt");
		// A non-marker body: even a probe that PASSES the guard stops at the marker check.
		writeFileSync(bodyFile, "not a marker\n");
	});
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it("refuses a wrong-namespace post from a policy-carrying root, exit 7", async () => {
		const {code, stderr} = await post(repoRoot, "design", bodyFile);
		if (code !== 7) {
			// The root may legitimately lack a policy (fresh clone, #64). Then the guard must have
			// said so — anything else is the fail-open this file exists to witness.
			assert.include(stderr, "did NOT run", `expected exit 7 or a loud skip, got exit ${code}`);
			return;
		}
		assert.include(stderr, "classifies to review-code, not review-design");
	}, 60_000);

	it("warns aloud and does not refuse from a policy-less root", async () => {
		const bare = mkdtempSync(join(tmpdir(), "ns-bare-"));
		try {
			execFileSync("git", ["init", "-q"], {cwd: bare});
			const {code, stderr} = await post(bare, "design", bodyFile);
			// The guard must not refuse (no trusted policy), must say the check did not run, and the
			// marker check must still stop the post — the exact row whose first version was silent.
			assert.notStrictEqual(code, 7, "a refusal from an untrusted policy is the fail-open's mirror");
			assert.include(stderr, "did NOT run");
			assert.include(stderr, "not a review-design: marker");
		} finally {
			rmSync(bare, {recursive: true, force: true});
		}
	}, 60_000);
});
