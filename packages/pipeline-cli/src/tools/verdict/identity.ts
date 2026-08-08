/**
 * Who is posting this verdict — the split-role firewall's decision, made over identities that were
 * READ rather than declared.
 *
 * The firewall's rule has always been right and its input was always wrong. `--as` defaulted to
 * `$CLAUDE_CODE_SESSION_ID`, and that value was compared against the PR's author LOGIN — a UUID
 * against a GitHub handle, two kinds of thing that cannot be equal. No skill passes `--as`, so every
 * documented invocation took that default: the refusal was unreachable, and the gate's one
 * structural guarantee held only when a caller volunteered its own true login on the command line
 * (#53). Measured on this repository: authenticated as `hueypov`, posting a `review-code` verdict on
 * a `hueypov`-authored PR through the invocation `review-code/SKILL.md` prints, the verb did not
 * refuse — it ran on to the marker check.
 *
 * The contract's stated scope — "the authoring session recorded by `write-code open-pr`" — describes
 * a recording that does not exist; `open-pr` reads a session only to check the issue claim and
 * writes none onto the PR. So the identity this decides over is the AUTHENTICATED account, the one
 * thing that is always readable and cannot be asserted into being something else. `post` already
 * reads it (`Github.whoAmI`, the login it trusts to find its own prior marker); it simply was never
 * the identity the firewall checked.
 *
 * `--as` survives as an ASSERTION, not a value: a caller may still state who it believes it is, and
 * a disagreement with the authenticated account is itself a refusal — that mismatch IS the incident
 * this closes (a session that switched accounts, switched back, and posted `--as nothueypov` while
 * authenticated as the author). Naming both sides is what makes the fix obvious to whoever hits it.
 */

/** A refusal to post, carrying the message that names both identities. */
export interface IdentityRefusal {
	/** `unresolved` fails closed on an unreadable identity; the other two are policy refusals. */
	readonly _tag: "unresolved" | "asserted-mismatch" | "self-verdict";
	readonly message: string;
}

export interface IdentityInput {
	readonly pr: number;
	/** The account `gh` is authenticated as. Empty when the read failed — never assumed. */
	readonly authenticated: string;
	/** The PR's author login. Empty when the read failed. */
	readonly author: string;
	/** What `--as` claimed, or null when the caller asserted nothing. */
	readonly asserted: string | null;
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * The refusal this post earns, or `null` to proceed.
 *
 * Order is deliberate. An identity that could not be read is decided FIRST, because every comparison
 * below it would otherwise be a comparison against the empty string — and "" equals "" is exactly
 * the shape that would let two unreadable identities read as two different people. A false `--as` is
 * decided BEFORE the self-verdict, because it names the cause: a caller that is wrong about who it
 * is has a bug to fix, and reporting only "you authored this" sends it looking in the wrong place.
 */
export const identityCheck = (input: IdentityInput): IdentityRefusal | null => {
	const authenticated = input.authenticated.trim();
	const author = input.author.trim();
	if (authenticated === "") {
		return {
			_tag: "unresolved",
			message: `cannot read the authenticated account (\`gh api user\`) — refusing rather than posting a verdict whose poster is unknown`,
		};
	}
	if (author === "") {
		return {
			_tag: "unresolved",
			message: `cannot read #${input.pr}'s author — refusing rather than posting a verdict the firewall could not check`,
		};
	}
	const asserted = input.asserted === null ? null : input.asserted.trim();
	if (asserted === "") {
		// Passed but empty is not "asserted nothing" — it is the shape `--as "$UNSET_VAR"` produces,
		// and letting it mean the same as omitting the flag would make a broken caller look careful.
		return {
			_tag: "unresolved",
			message: `--as was given an empty value — omit it to accept the authenticated account, or pass the login you mean`,
		};
	}
	if (asserted !== null && !same(asserted, authenticated)) {
		return {
			_tag: "asserted-mismatch",
			message: `--as ${asserted} disagrees with the authenticated account ${authenticated} — a verdict is attributed to whoever \`gh\` is logged in as, not to what --as claims; run \`gh auth switch --user ${asserted}\` if that is who should be reviewing`,
		};
	}
	if (same(authenticated, author)) {
		return {
			_tag: "self-verdict",
			message: `#${input.pr} was authored by ${author} and \`gh\` is authenticated as ${authenticated} — an author may not post a verdict on their own work`,
		};
	}
	return null;
};
