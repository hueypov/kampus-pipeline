# Dimension: functional-rite

Walk the v1 earned-authorship rite end to end and assert **every** candidate-contributor → established-contributor transition: a
fresh candidate contributor self-registers, writes to the sandbox, gets reviewed and **endorseed** by the seeded
reviewer fixture in `$RITE_REVIEW_ROUTE`, is promoted, has their tier flip to established contributor, and finds their next write goes
**live**. Each transition emits one `Finding`; a missing or broken transition is an unmistakable
FAIL, never a silent pass (the failure-visibility invariant).

Read [`../DIMENSIONS.md`](../DIMENSIONS.md) first — the `Finding` / `DimensionResult` shapes, the
status semantics, and the shared primitives are defined there and consumed here.

## Declaration

- **`id`** — `functional-rite`
- **`surfaces`** — `$RITE_REGISTRATION_ROUTE`, `$RITE_REFERENCE_CONTENT_ROUTE` (and/or `$RITE_SUBMISSION_ROUTE`), `$RITE_REVIEW_ROUTE`, `$RITE_PROFILE_ROUTE`
- **`probe`** — register a fresh candidate contributor → write to the sandbox → (as the reviewer fixture) review + endorse
  in `$RITE_REVIEW_ROUTE` → promote → re-read the candidate contributor's `$RITE_PROFILE_ROUTE` tier → make the next write and check it
  goes live. Two browser contexts: one for the self-registered candidate contributor, one for the reviewer fixture.
- **`rubric`** — the ordered checks T1–T6 below.

## How promotion via the endorse path actually works (ground the rubric in the code)

The issue names the repository-configured endorsement action as the promotion path, so this dimension
drives the **endorse** affordance (the configured endorsement action), not the mod direct-promote. But an endorsement promotes
through a **tandem**, not on its own — ground the walk in the rite code so the assertions are
honest:

- A candidate contributor's new reference-content item lands **sandboxed** when the flag is on
  (the repository lifecycle-containment implementation; see the repository containment-seam record). Sandboxed content earns the author **contribution score** only through the configured review workflow; public interaction paths must reject a sandboxed target.
- The adapter must identify the score-bearing review action, its reviewer-eligibility rule, and the
  authoritative observation that proves the candidate crossed the configured threshold. Record each
  of those observations in the T4 evidence; do not infer a score source or reviewer capability.
- An endorsement (under the repository's configured reviewer-eligibility rule) plus the candidate **crossing the configured contribution-score threshold** `$PIPELINE_RITE_PROMOTION_SCORE_THRESHOLD` is what auto-promotes:
  `resolveTandem` reads both halves and short-circuits if the endorse is absent, so an unendorseed
  candidate contributor is never promoted by contribution score alone (and the `CandidateStatusBlock` shows the endorse-needed
  framing, not a contribution score bar, until an endorsement exists).

So the endorsement-path walk is: the reviewer fixture **applies the configured review action to the candidate contributor's sandboxed item(s) in `$RITE_REVIEW_ROUTE`** to
push global contribution score to at least `$PIPELINE_RITE_PROMOTION_SCORE_THRESHOLD`, **and** **endorsees** — the tandem then auto-promotes candidate-contributor → established-contributor. T4
drives both halves and asserts the promotion they produce. (The mod direct-promote `promote-button`
exists as an alternative trigger but is out of this dimension's named path; note it in evidence if
the endorse tandem can't promote, as a candidate product-gap.)

## The rubric — T1 through T6 (each emits one `Finding`)

All navigation is `${baseUrl}<path>` from the run context. The reviewer fixture login comes from
`reviewerFixture.email` / `reviewerFixture.password`; the candidate contributor is **self-registered fresh** with a per-run unique
email so the run never depends on a leftover account.

### T1 — candidate contributor self-registration (configured authentication sign-up, auto-sign-in)

- **drive** — In the candidate contributor context, open `$RITE_REGISTRATION_ROUTE`, switch to the "configured registration action" (register) form, fill
  `name` / `email` (a per-run unique address) / `username` / `password`, submit. (This is the UI
  side of the no-verify auto-sign-in path `the repository-configured registration endpoint`.)
- **observe** — The session establishes and lands signed-in (redirected off `$RITE_REGISTRATION_ROUTE`); the topbar
  shows the signed-in affordances (the `+ gönderi` action, the username).
- **assert / record** — PASS iff sign-up succeeds and the session is auto-established (no email
  verification gate blocks it). No session ⇒ FAIL (the rite cannot start). `surface: $RITE_REGISTRATION_ROUTE`.

### T2 — the write lands sandboxed

- **drive** — As the new candidate contributor, create a reference-content item (open or visit a `$RITE_REFERENCE_CONTENT_ROUTE` term
  and add a definition) and/or a feed item via `$RITE_SUBMISSION_ROUTE`.
- **observe** — The write is accepted, but is **not** publicly live: on the candidate contributor's own
  `$RITE_PROFILE_ROUTE` the `candidate-status-block` shows `candidate-status-in-review` incremented (the
  "incelemede" count), and the definition does **not** appear on the public term page / feed for a
  signed-out viewer.
- **assert / record** — PASS iff the write is accepted **and** observably sandboxed (in-review
  count rose and the item is absent from the public surface). Accepted-but-live, or rejected ⇒
  FAIL. `surface: $RITE_REFERENCE_CONTENT_ROUTE` (or `$RITE_SUBMISSION_ROUTE`).

### T3 — the candidate is reviewable in `$RITE_REVIEW_ROUTE`

- **drive** — In the reviewer fixture context, log in (`reviewerFixture` credentials), open `$RITE_REVIEW_ROUTE`.
- **observe** — `$RITE_REVIEW_ROUTE` resolves (does not 404 — the flag is forced on) and the roster lists the
  candidate contributor under test: `review-candidate-<authorId>` is present, and the candidate's sandboxed item
  carries the `in-review-badge`.
- **assert / record** — PASS iff `$RITE_REVIEW_ROUTE` resolves for the reviewer fixture and the candidate appears in
  the roster. `$RITE_REVIEW_ROUTE` 404 ⇒ **BLOCKED** (the flag-force seam the repository flag-force record is broken — the rite cannot be
  reviewed; rolls up FAIL). Candidate absent ⇒ FAIL. `surface: $RITE_REVIEW_ROUTE`.

### T4 — endorse (the tandem) promotes the candidate

- **drive** — As the reviewer fixture in `$RITE_REVIEW_ROUTE`: apply the repository-configured score-bearing review action to the candidate's sandboxed item(s)
  (the adapter supplies its selector and action semantics) until the author's contribution score reaches
  `$PIPELINE_RITE_PROMOTION_SCORE_THRESHOLD`, then open the candidate and **endorse** through the configured
  endorsement action. Confirm in the adapter-provided endorsement surface, which calls the repository-configured
  endorsement action.
- **observe** — The endorse records (the sheet reports success, no `FORBIDDEN` / `VOUCH_LIMIT_REACHED`),
  and with the contribution score bar crossed the tandem auto-promotes: the candidate leaves the candidate contributor roster /
  is marked promoted.
- **assert / record** — PASS iff the endorse records **and** the candidate is promoted by the
  endorse+contribution score tandem. Endorse rejected ⇒ FAIL. Endorse records but **no** promotion results (tandem did
  not fire) ⇒ FAIL — and capture in `evidence` whether the contribution score bar was actually crossed and
  whether the mod direct-promote would have worked, since an endorsement that can't promote is exactly the
  kind of real product gap this audit exists to surface. `surface: $RITE_REVIEW_ROUTE`.

### T5 — the tier flips candidate contributor → established contributor

- **drive** — Back in the candidate contributor context (refresh the session), open `$RITE_PROFILE_ROUTE`.
- **observe** — The `candidate-status-block` is **gone** (it renders only for a `candidate contributor` viewing their
  own profile — `CandidateStatusBlock.shouldShowCaylakStatus`), and the profile-header standing label
  reads **`established contributor`** (`profileStandingLabel`). Optionally cross-check the tier via `$RITE_PUBLIC_PROFILE_ROUTE`.
- **assert / record** — PASS iff the tier reads `established contributor` and the candidate contributor status block has
  disappeared. Still `candidate contributor` / block still present ⇒ FAIL (promotion did not propagate to the
  authoritative tier read). `surface: $RITE_PROFILE_ROUTE`.

### T6 — the next write goes live

- **drive** — As the now-established contributor, make a new write (another reference-content item or feed item).
- **observe** — The new write is **live immediately**: it appears on the public term page / feed
  for a signed-out viewer and does **not** increment the in-review count — no longer sandboxed
  (`alwaysLive` / `decidePublish` for a established contributor).
- **assert / record** — PASS iff the new write is publicly visible without review (live). Still
  sandboxed ⇒ FAIL (the promotion did not change the write path — the rite's payoff is missing).
  `surface: $RITE_REFERENCE_CONTENT_ROUTE` (or `$RITE_FEED_ROUTE`).

## Roll-up

Per [`../DIMENSIONS.md`](../DIMENSIONS.md): `functional-rite` is **PASS iff T1–T6 are all PASS**;
any FAIL or BLOCKED ⇒ the dimension FAILs. Emit all six `Finding`s (never drop one), with
screenshots as evidence at each transition, and hand the bundle to the harness for the the repository verdict-report record
verdict report.
