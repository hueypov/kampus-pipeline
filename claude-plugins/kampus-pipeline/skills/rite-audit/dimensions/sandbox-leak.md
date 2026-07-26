# Dimension: sandbox-leak

Prove the **containment** property black-box at the live surface: a candidate contributor's sandbox content —
written but **not yet promoted** — is **invisible** to everyone except the candidate contributor (and a
moderator), on every public surface where it could leak. The explorer establishes a
still-sandboxed author, then checks that content from two unprivileged vantages — **anonymous**
and a **second unrelated registered user** — across `$RITE_SEARCH_ROUTE`, the `$RITE_FEED_ROUTE` feed, the landing
stats, and the author's `$RITE_PUBLIC_PROFILE_ROUTE`. A single surface where the sandbox content surfaces to
anon or the second user is an unmistakable **sandbox-leak FAIL**, never a silent pass (the failure-visibility invariant).

Read [`../DIMENSIONS.md`](../DIMENSIONS.md) first — the `Finding` / `DimensionResult` shapes, the
status semantics, and the shared primitives are defined there and consumed here.

## Declaration

- **`id`** — `sandbox-leak`
- **`surfaces`** — `$RITE_SEARCH_ROUTE`, `$RITE_FEED_ROUTE` (the public feed), `$RITE_LANDING_ROUTE` (landing stats / counters),
  `$RITE_PUBLIC_PROFILE_ROUTE` (the author's public profile)
- **`probe`** — establish a still-sandboxed candidate contributor author (self-register a fresh candidate contributor, write
  sandbox content, **never promote**), register a **second** unrelated candidate contributor distinct from the
  author and the reviewer fixture, then read each of the four surfaces from **two vantages** — anonymous
  (no session) and the second user's session — asserting the author's sandbox content is absent
  from all of them. Three browser contexts: the author, the second user, and a clean
  no-session/anonymous context.
- **`rubric`** — the ordered per-surface × per-vantage checks S1–S8 below.

## How this dimension gets its fixture (ground the rubric in the seam)

The property under audit is the containment seam `the repository lifecycle containment implementation`
(the repository containment-seam record): a candidate contributor's write lands `sandboxed_at`-stamped while `$PIPELINE_RITE_LIFECYCLE_FLAG` is on, and
the read paths filter it out for every non-author/non-moderator viewer. The four surfaces each
consume that filter:

- **`$RITE_SEARCH_ROUTE`** — the repository-configured discovery query applies the shared visibility policy, so a sandboxed item must not appear in results.
- **`$RITE_FEED_ROUTE` feed** — the same `postVisibleWhere` gates the public feed query.
- **landing stats (`$RITE_LANDING_ROUTE`)** — the repository-configured public counter applies the live-content visibility policy, which excludes sandboxed (and removed) rows, so a
  sandboxed write must not move the public counters.
- **`$RITE_PUBLIC_PROFILE_ROUTE`** — the repository-configured public-profile query lists an author's *public* contributions, so
  a sandboxed item must not show on a third party's view of the author's profile.

This dimension verifies all four **black-box at the live surface**, complementing the unit /
integration coverage of the seam.

The adapter maps these generic surfaces to the repository's own content types and selectors. The
containment assertion is unchanged: pending content must stay absent from every public read path
and public aggregate until the configured lifecycle transition makes it eligible for publication.

**The fixture is self-registered and never promoted — by design.** Per
[`../DIMENSIONS.md`](../DIMENSIONS.md) (*Running a dimension*), a dimension that needs its own
fixture self-registers it through the UI rather than depending on another dimension's state. The
functional-rite dimension (the repository functional-rite record) **promotes** its candidate contributor (its T4 endorse tandem flips the author to
established contributor and the content live), so its author does **not** stay sandboxed — reusing it would observe
*promoted* content, not the *before-promotion* state this dimension must assert. So sandbox-leak
stands up its **own** fresh candidate contributor author and **never promotes it**, which is exactly the
"before promotion" state the acceptance criteria name. (When sandbox-leak is run interleaved on the
shared stage *between* functional-rite's T2 write and its T4 promotion, that still-sandboxed author
may be reused instead; the self-registered fixture is the independent default.)

## The probe — establish the fixture, then read from two vantages

All navigation is `${baseUrl}<path>` from the run context; the reviewer fixture (`reviewerFixture.email` /
`reviewerFixture.password`) is referenced only as the identity the second user must be **distinct from** —
this dimension drives no moderator action. Both candidate contributors are self-registered fresh with per-run
unique emails so the run never depends on a leftover account.

1. **Record the public landing baseline (anonymous).** In a clean no-session context, open `$RITE_LANDING_ROUTE` and
   read the landing stat counters that the upcoming sandbox write would move (the reference-content
   / feed item corpus counters). Capture these baseline values — the landing-stats checks assert the
   sandbox write does **not** move them. A concrete read (pasted into `browser_evaluate`), anchored
   on the landing stat block element:

   ```js
   // Read the landing stat counters as integers, keyed by their stat-block label/testid.
   // Anchor on the landing stat block element (route map: "landing stat blocks"); adapt the
   // selector to the rendered testid. Returns e.g. { "reference-content": 412, "feed": 87 }.
   () =>
     Object.fromEntries(
       Array.from(document.querySelectorAll("[data-testid^='landing-stat']")).map((el) => [
         el.getAttribute("data-stat") ?? el.textContent?.trim(),
         parseInt((el.querySelector("[data-stat-value]") ?? el).textContent.replace(/\D/g, ""), 10),
       ]),
     )
   ```

2. **Establish the still-sandboxed author.** In the author context, self-register a fresh candidate contributor
   via `$RITE_REGISTRATION_ROUTE` (the "configured registration action" form), then write sandbox content that touches all four surfaces:
   a **reference-content item** (for `$RITE_SEARCH_ROUTE` + `$RITE_PUBLIC_PROFILE_ROUTE`) at a `$RITE_REFERENCE_CONTENT_ROUTE` term and a **feed item** via `$RITE_SUBMISSION_ROUTE` (for the `$RITE_FEED_ROUTE` feed). Use a **distinctive, per-run unique marker
   string** in both bodies (e.g. a `sandbox-leak-<nonce>` token) so it is unambiguously findable.
   Confirm the writes landed **sandboxed** (the author's own `$RITE_PROFILE_ROUTE` `candidate-status-block`
   in-review count rose) and **do not promote** — leave the author a candidate contributor.

3. **Register the second unrelated user.** In the second-user context, self-register another fresh
   candidate contributor (a different unique email), distinct from the author and from `reviewerFixture`. This is an
   ordinary signed-in member with no moderation authority and no relationship to the author.

4. **Read each surface from both vantages.** For each of the four surfaces, observe it twice — once
   in the **anonymous** (no-session) context and once in the **second-user** context — searching for
   the author's distinctive marker (and, for landing stats, comparing the counters against the
   step-1 baseline). Anchor on the surface's `data-testid` (route map) and capture a screenshot as
   evidence for each observation.

## The rubric — S1 through S8 (each emits one `Finding`)

Eight checks: the four surfaces × the two vantages. The vantage is **folded into the check name**
(`invisible-to-anon` / `invisible-to-second-user`) and the surface rides in the `Finding`'s
`surface` field, so findings key cleanly on the `(dimension, check, surface)` triple. Each check
emits **exactly one** `Finding`; a surface unreachable from a vantage is **BLOCKED**, never a
silent pass (it rolls up FAIL).

### S1 — `$RITE_SEARCH_ROUTE` invisible to anon

- **check** — `invisible-to-anon`, **surface** `$RITE_SEARCH_ROUTE`
- **drive / observe** — In the anonymous context, open `$RITE_SEARCH_ROUTE` and query the author's distinctive
  marker; read the results list.
- **assert / record** — PASS iff the author's sandbox definition/post is **absent** from the
  results. Present ⇒ **FAIL** (leak; evidence: the offending result row + the query). `$RITE_SEARCH_ROUTE`
  unreachable ⇒ **BLOCKED**. `surface: $RITE_SEARCH_ROUTE`.

### S2 — `$RITE_SEARCH_ROUTE` invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `$RITE_SEARCH_ROUTE`
- **drive / observe** — In the second-user context, open `$RITE_SEARCH_ROUTE` and run the same marker query.
- **assert / record** — PASS iff the sandbox content is **absent** from the second user's results.
  Present ⇒ **FAIL** (evidence: the result row). Unreachable ⇒ **BLOCKED**. `surface: $RITE_SEARCH_ROUTE`.

### S3 — `$RITE_FEED_ROUTE` feed invisible to anon

- **check** — `invisible-to-anon`, **surface** `$RITE_FEED_ROUTE`
- **drive / observe** — In the anonymous context, open `$RITE_FEED_ROUTE` and scan the feed items for the
  author's marked sandbox post.
- **assert / record** — PASS iff the sandbox post is **absent** from the public feed. Present ⇒
  **FAIL** (evidence: the feed item). Feed unreachable ⇒ **BLOCKED**. `surface: $RITE_FEED_ROUTE`.

### S4 — `$RITE_FEED_ROUTE` feed invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `$RITE_FEED_ROUTE`
- **drive / observe** — In the second-user context, open `$RITE_FEED_ROUTE` and scan the feed.
- **assert / record** — PASS iff the sandbox post is **absent** from the second user's feed.
  Present ⇒ **FAIL** (evidence: the feed item). Unreachable ⇒ **BLOCKED**. `surface: $RITE_FEED_ROUTE`.

### S5 — landing stats invisible to anon

- **check** — `invisible-to-anon`, **surface** `$RITE_LANDING_ROUTE`
- **drive / observe** — In the anonymous context, open `$RITE_LANDING_ROUTE` and re-read the landing stat counters
  (the step-1 `browser_evaluate` snippet).
- **assert / record** — PASS iff the counters **equal the step-1 baseline** — the sandbox write did
  not move the public count. A counter **incremented** by the sandbox write ⇒ **FAIL** (leak;
  evidence: baseline vs observed values). Counters unreadable ⇒ **BLOCKED**. `surface: /`.

### S6 — landing stats invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `$RITE_LANDING_ROUTE`
- **drive / observe** — In the second-user context, open `$RITE_LANDING_ROUTE` and re-read the counters.
- **assert / record** — PASS iff the counters **equal the step-1 baseline** (the sandbox write is
  not counted for the second user either). Incremented ⇒ **FAIL** (evidence: baseline vs observed).
  Unreadable ⇒ **BLOCKED**. `surface: /`.

### S7 — `$RITE_PUBLIC_PROFILE_ROUTE` invisible to anon

- **check** — `invisible-to-anon`, **surface** `$RITE_PUBLIC_PROFILE_ROUTE`
- **drive / observe** — In the anonymous context, open the **author's** `/u/<author-username>` and
  read the listed contributions.
- **assert / record** — PASS iff the author's sandbox content is **absent** from their public
  profile. Present ⇒ **FAIL** (leak; evidence: the listed item). Profile unreachable ⇒ **BLOCKED**.
  `surface: $RITE_PUBLIC_PROFILE_ROUTE`.

### S8 — `$RITE_PUBLIC_PROFILE_ROUTE` invisible to the second user

- **check** — `invisible-to-second-user`, **surface** `$RITE_PUBLIC_PROFILE_ROUTE`
- **drive / observe** — In the second-user context, open the author's `/u/<author-username>` and
  read the contributions.
- **assert / record** — PASS iff the sandbox content is **absent** from the author's profile as seen
  by the second user. Present ⇒ **FAIL** (evidence: the listed item). Unreachable ⇒ **BLOCKED**.
  `surface: $RITE_PUBLIC_PROFILE_ROUTE`.

## Roll-up

Per [`../DIMENSIONS.md`](../DIMENSIONS.md): `sandbox-leak` is **PASS iff S1–S8 are all PASS**; any
FAIL or BLOCKED ⇒ the dimension FAILs. Emit all eight `Finding`s (never drop one), each with the
distinctive marker / counter values / screenshot as evidence, and hand the bundle to the harness
for the the repository verdict-report record verdict report. A single surface where the sandbox content reaches anon or the second
user is the leak this dimension exists to make unmistakable.
