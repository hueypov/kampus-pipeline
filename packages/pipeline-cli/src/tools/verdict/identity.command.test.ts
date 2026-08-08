/**
 * Spawned-bin witnesses for the split-role firewall — the tests whose absence let it never fire.
 *
 * The unit suite pins the DECISION. It cannot pin which identity reaches it, and that was the whole
 * defect: `identityCheck`'s predecessor was correct about "a poster who is the author is refused"
 * while being handed a session UUID as the poster (#53). Only a spawned process observes the
 * identity the verb actually reads.
 *
 * These derive their case from the environment instead of skipping when it doesn't match, so there
 * is no branch that quietly asserts nothing:
 *
 *   - identity unreadable (CI's `GITHUB_TOKEN` cannot `GET /user`; also any offline run)
 *       → the fail-closed refusal, exit 11
 *   - identity readable, and it authored the probe PR
 *       → the self-verdict refusal, exit 10
 *   - identity readable, and it did not
 *       → the firewall passes and the post stops at the marker check, exit 1
 *
 * Every run takes exactly one of those and asserts it, plus the `--as`-disagrees refusal whenever
 * both identities are readable. The branch taken is printed, so a reader of CI output can see which
 * coverage this run actually bought rather than inferring it from a green tick.
 *
 * Probe safety: the body's first line is a non-marker, so a probe that passes the firewall stops at
 * the emission check and nothing can ever land on the PR.
 */
import {execFile, execFileSync} from "node:child_process";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {afterAll, assert, beforeAll, describe, it} from "@effect/vitest";

const BIN = fileURLToPath(new URL("../../bin.ts", import.meta.url));
const REPO = "hueypov/kampus-pipeline";
/** A merged PR in this repository, read-only. Its author is read here, never assumed. */
const PROBE_PR = "70";

/** `gh` reads, run directly — an empty string means "could not read", never a login. */
const readOut = (args: ReadonlyArray<string>): string => {
	try {
		return execFileSync("gh", args, {encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
	} catch {
		return "";
	}
};

interface RunResult {
	readonly code: number;
	readonly stderr: string;
}

const post = (args: ReadonlyArray<string>, bodyFile: string): Promise<RunResult> =>
	new Promise((resolve) => {
		execFile(
			"node",
			[BIN, "verdict", "post", "--pr", PROBE_PR, "--gate", "code", ...args, "--body-file", bodyFile],
			{env: {...process.env, CLAUDE_PIPELINE_REPO: REPO}},
			(error, _stdout, stderr) => {
				const code =
					error && typeof (error as {code?: unknown}).code === "number"
						? (error as {code: number}).code
						: 0;
				resolve({code, stderr});
			},
		);
	});

const me = readOut(["api", "user", "--jq", ".login"]);
const author = me === "" ? "" : readOut(["api", `repos/${REPO}/pulls/${PROBE_PR}`, "--jq", ".user.login"]);
const readable = me !== "" && author !== "";

describe("verdict post — the split-role firewall, over the identity it actually reads (#53)", () => {
	let dir: string;
	let bodyFile: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "verdict-identity-"));
		bodyFile = join(dir, "body.txt");
		writeFileSync(bodyFile, "not a marker\n");
		// eslint-disable-next-line no-console
		console.error(
			readable
				? `identity.command.test: authenticated as '${me}', #${PROBE_PR} authored by '${author}' — exercising the ${me.toLowerCase() === author.toLowerCase() ? "SELF-VERDICT" : "permitted-reviewer"} branch`
				: `identity.command.test: identity unreadable (login='${me}', author='${author}') — exercising the FAIL-CLOSED branch`,
		);
	});
	afterAll(() => rmSync(dir, {recursive: true, force: true}));

	it("takes the branch its environment determines, and refuses unless a second party is posting", async () => {
		const {code, stderr} = await post([], bodyFile);
		if (!readable) {
			// CI's GITHUB_TOKEN cannot GET /user, and an offline run reads nothing either. Both must
			// refuse: a verdict whose poster is unknown is not a second-party review.
			assert.strictEqual(code, 11, `an unreadable identity is PRECONDITION_UNKNOWN, not a pass — got: ${stderr}`);
			assert.match(stderr, /cannot read (the authenticated account|#\d+'s author)/);
			return;
		}
		if (me.toLowerCase() === author.toLowerCase()) {
			// The measured defect, reproduced through the invocation review-code/SKILL.md prints.
			assert.strictEqual(code, 10, `an author posting on their own PR must be REFUSED_POLICY — got: ${stderr}`);
			assert.include(stderr, "may not post a verdict on their own work");
			assert.include(stderr, author);
			return;
		}
		// A permitted reviewer gets past the firewall and is stopped only by the non-marker body —
		// which is also the proof that the refusals above are the firewall's, not some earlier guard's.
		assert.strictEqual(code, 1, `a second party must reach the emission check — got: ${stderr}`);
		assert.include(stderr, "is not a review-code: marker");
	}, 60_000);

	it("refuses a --as that disagrees with the authenticated account, naming both", async () => {
		if (!readable) {
			assert.strictEqual((await post(["--as", "someone-else"], bodyFile)).code, 11);
			return;
		}
		// `--as` can no longer stand in for the caller: this is PR #47's incident, where a session
		// authenticated as the author posted `--as nothueypov` and the old check accepted it.
		const {code, stderr} = await post(["--as", `${me}-definitely-not-me`], bodyFile);
		assert.strictEqual(code, 10, `a false --as must be REFUSED_POLICY — got: ${stderr}`);
		assert.include(stderr, `--as ${me}-definitely-not-me`);
		assert.include(stderr, `authenticated account ${me}`);
	}, 60_000);
});
