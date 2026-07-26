---
name: rite-audit
description: >-
  Drive the Playwright MCP against a flag-on audit stage to walk the v1 earned-authorship rite (candidate-contributor → established-contributor) as an agentic explorer and emit raw pass/fail findings per dimension. Trigger on "run the rite audit", "audit the authorship rite", "rite-audit", "walk the candidate-contributor → established-contributor rite", "/rite-audit". This is the audit harness's explorer: it consumes the ephemeral stage lifecycle ($PIPELINE_RITE_AUDIT_STAGE_ADAPTER, the repository audit-stage record) — its base URL + minted reviewer fixture — provisioned by epic the repository rite-audit record, runs each registered dimension over that one stage, and produces the raw findings the verdict report (the repository verdict-report record) structures and archives. It never deploys, seeds, or destroys the stage (that is $PIPELINE_RITE_AUDIT_STAGE_ADAPTER), and never runs against production.
---

# rite-audit

## Repository-owned integration contract

This optional workflow is a generic, fail-closed audit harness for any gated contributor lifecycle. Before a run, the consumer repository must enable it in `.pipeline/optional-workflow-policy.json`; its audit-stage adapter must then provide an ephemeral non-production stage, the feature flag or other lifecycle gate forced into the intended state, the `AuditRunInput` equivalent, a reviewer fixture, configured identity roles, a route map, selectors, audit-target access where direct assertions are required, and a verdict-report destination. It must also bind these route variables: `$RITE_REGISTRATION_ROUTE`, `$RITE_REFERENCE_CONTENT_INDEX_ROUTE`, `$RITE_REFERENCE_CONTENT_ROUTE`, `$RITE_SUBMISSION_ROUTE`, `$RITE_FEED_ROUTE`, `$RITE_FEED_ITEM_ROUTE`, `$RITE_REVIEW_ROUTE`, `$RITE_PROFILE_ROUTE`, `$RITE_PUBLIC_PROFILE_ROUTE`, `$RITE_SEARCH_ROUTE`, and `$RITE_LANDING_ROUTE`.

Do not substitute a production URL, literal credentials, source-product routes, or assumed roles. Without this adapter and run context, record the run as blocked and stop. The detailed drive → observe → assert → record procedure and BLOCKED-is-not-PASS invariant below remain mandatory.

You are the **agentic explorer** of the earned-authorship rite. The product question this
harness answers is not "does each unit test pass" but "**can a real person walk the whole
candidate-contributor → established-contributor rite end to end, on a real deployed stage, with no human in the loop?**" You
answer it by driving a browser through the rite the way a person would — register, write,
get endorseed, watch your tier flip — and recording, transition by transition, whether each
step actually happened. A judgment audit, not a fixed spec suite (epic
the repository rite-audit record).

You run **against an ephemeral audit stage, never production.** The `$PIPELINE_RITE_LIFECYCLE_FLAG`
flag is an all-or-nothing kill-switch with no targeting — flipping it on in production releases
v1 to the public — so the rite is only walkable where the repository flag-force record forces the flag on: the dedicated
configured audit deployment class deploy class. The stage is provisioned, seeded, and torn down by
the repository audit-stage adapter
(the repository audit-stage record); **you are the run hook it invokes**, not the lifecycle. You receive the live stage's
coordinates and drive it; you never deploy, seed, mint, or destroy anything.

## The split of responsibilities — what you own vs what you consume

- **`$PIPELINE_RITE_AUDIT_STAGE_ADAPTER` (the repository audit-stage record) owns the stage.** It deploys the configured audit deployment class stage (flag forced
  on by the repository flag-force record), preview-seeds it, mints a login-able reviewer fixture, calls **you** through its
  `runHook` seam, then tears the stage down on every exit path. You never touch deploy/seed/destroy.
- **You (this skill) own the walk.** Given the stage's coordinates and the reviewer fixture, you drive
  the Playwright MCP through each registered **dimension** and emit that dimension's raw findings.
- **The verdict report (the repository verdict-report record) owns the archive.** You emit *raw* findings (the union of every
  dimension's `Finding`s); the repository verdict-report record structures them into the dated, run-over-run-comparable verdict
  and archives it. Do not format an archive here — emit findings, hand off.

## Consume the run context — never hardcode a URL or credentials

Everything stage-specific arrives as the **run context**, the
the repository-defined `AuditRunInput` equivalent
the lifecycle hands its `runHook` (the seam you fill). It is the single source of the stage's
identity:

```ts
interface AuditRunInput {
  readonly stage: string;      // the audit stage name
  readonly baseUrl: string;    // the deployed stage's worker base URL — drive THIS, never a literal
  readonly target: AuditTarget;   // the repository-provided audit target (accountId, databaseId) — for direct-D1 assertions
  readonly reviewerFixture: ReviewerFixture;   // the minted moderator+established contributor identity
}
interface ReviewerFixture {
  readonly userId: string;     // the configured authentication user.id of the seeded mod
  readonly email: string;      // login credential for the review workspace endorse/promote
  readonly password: string;
}
```

**Hardcoding a stage URL or any credential is a defect, not a shortcut.** The stage is
ephemeral — its URL changes every run, and the reviewer fixture is freshly minted per run — so a
literal would be stale on the next run and would point a flag-on audit at the wrong target.
Read `baseUrl` and `reviewerFixture` off the run context and pass them into every dimension. If you
are invoked without a run context (a bare manual run), **stop and report that the stage
lifecycle must provide it** — do not invent one.

The reviewer fixture is the *only* pre-existing identity. The candidate contributor under test is **not** seeded:
each run **self-registers a fresh candidate contributor** through the UI (the rite's first transition), so
the audit exercises the real sign-up path and never depends on a leftover account.

## Playwright MCP wiring

Drive the stage through the Playwright MCP browser tools (navigate, click, type, read text,
snapshot/screenshot). The contract for the explorer:

- **Navigate by `baseUrl` + a route-map path**, never a literal origin: `${baseUrl}${path}`.
- **Anchor on stable `data-testid`s** where the surface exposes them (the route map lists the
  load-bearing ones). Prefer a testid over visible Turkish copy so a copy tweak never silently
  breaks the walk; fall back to the glossary-canonical Turkish label only where no testid exists.
- **One browser context per identity.** The candidate contributor and the reviewer fixture are distinct sessions —
  drive them in separate contexts (or sign out fully between them) so a stale session never
  leaks one identity's authority into the other's assertions.
- **Observe before you assert.** Every check is `drive → observe → assert → record`: take the
  action, read the resulting DOM/text/screenshot, compare against the rubric's expectation,
  then emit exactly one `Finding`. Capture a screenshot as evidence at each asserted transition
  (the verdict report attaches them).
- **Force a browser media state via the `emulateMedia` seam.** When a check must *force* a media
  feature rather than read the stage default, drive the `browser_emulate_media`-style MCP tool
  over Playwright's page-level `page.emulateMedia({ reducedMotion, colorScheme, forcedColors })`
  (a CDP `Emulation.setEmulatedMedia` bridge). This single seam covers all three feature axes, so
  a dimension can force `prefers-reduced-motion: reduce`, `prefers-color-scheme: dark`, or
  `forced-colors: active` before it observes — it is general, not reduced-motion only.
  `browser_evaluate` can only *read* the current media state
  (`matchMedia('(prefers-reduced-motion: reduce)').matches`); reading the default is not a
  drive-test — force the feature ON through this seam first, then observe the app's response and
  restore the default (`{ reducedMotion: 'no-preference' }`) after. If the seam is absent from the
  exposed tool surface, that is a **BLOCKED** precondition for any check that depends on it (story
  11), never a silent pass.

## The route map — the rite surfaces

Grounded in the repository-owned route map supplied by the audit-stage adapter.
Every dimension walks a subset of these; navigate each as `${baseUrl}<path>`.

| Path | Surface | Role in the rite | Key anchors |
| --- | --- | --- | --- |
| `$RITE_REGISTRATION_ROUTE` | configured registration surface | candidate contributor self-registration (the "configured registration action" form) + reviewer fixture login | form fields by `name`: `email`, `password`, `username`, `name` |
| `$RITE_REFERENCE_CONTENT_INDEX_ROUTE` · `$RITE_REFERENCE_CONTENT_ROUTE` | configured reference-content surfaces | a sandbox write target (a candidate contributor definition lands sandboxed) | term page definition list |
| `$RITE_SUBMISSION_ROUTE` · `$RITE_FEED_ROUTE` · `$RITE_FEED_ITEM_ROUTE` | configured submission and feed surfaces | the other sandbox write target + the public feed (live visibility) | submit form; feed items |
| `$RITE_REVIEW_ROUTE` | configured review surface | the reviewer workspace — **404 when the flag is off** (gates the whole rite) | `review-candidate-<authorId>`, `endorse-button`, `promote-button`, `review-upvote-<id>`, `in-review-badge` |
| `$RITE_PROFILE_ROUTE` | configured contributor-status surface | the candidate contributor's own tier readout (the flip surface) | `candidate-status-block`, `candidate-status-in-review`, `candidate-status-endorse` |
| `$RITE_PUBLIC_PROFILE_ROUTE` | configured public-profile surface | a third party's view of the author (cross-user visibility) | profile header standing label |
| `$RITE_SEARCH_ROUTE` | configured discovery surface | a cross-user discovery surface (sandbox-leak dimension) | results list |
| `$RITE_LANDING_ROUTE` | configured landing surface | landing stats / featured corpus | landing stat blocks |

> `$RITE_REVIEW_ROUTE` **self-gates on `$PIPELINE_RITE_LIFECYCLE_FLAG`** (404 when the flag is off — the configured route map).
> On the audit stage the repository flag-force record forces the flag on, so `$RITE_REVIEW_ROUTE` resolves for an authorized
> (established contributor / authorized reviewer) viewer. If `$RITE_REVIEW_ROUTE` 404s on the stage, the flag-force seam is broken — that is a
> **BLOCKED** precondition for the functional rite (which rolls up FAIL), not a silent skip.

## The dimension model — the fixed-rubric extension point

The audit is a set of independent **dimensions**, each a self-contained vertical (its surfaces +
its explorer steps + its pass/fail rubric) that runs over the *same* provisioned stage and emits
its own raw findings. The dimension is the unit of extension: later children add a dimension by
dropping one file, with no change to the harness.

**The full contract — what a dimension declares, the shared primitives it consumes, the
`Finding` / `DimensionResult` shape it emits, and the registration step — lives in
[`DIMENSIONS.md`](./DIMENSIONS.md). Read it before adding or running a dimension.** It is the
documented interface a11y (the repository accessibility record) and sandbox-leak (the repository containment-audit record) plug into and that the verdict
report (the repository verdict-report record) aggregates; treat it as the contract, not a suggestion.

### Active dimensions

Each registered dimension is one file under [`dimensions/`](./dimensions/). Run every active
dimension over the one provisioned stage, in order, collecting each `DimensionResult`.

| `id` | File | Status |
| --- | --- | --- |
| `functional-rite` | [`dimensions/functional-rite.md`](./dimensions/functional-rite.md) | active (this child, the repository functional-rite record) |
| `accessibility` | [`dimensions/accessibility.md`](./dimensions/accessibility.md) | active (the repository accessibility record) |
| `sandbox-leak` | [`dimensions/sandbox-leak.md`](./dimensions/sandbox-leak.md) | active (the repository containment-audit record) |

## The run procedure

1. **Receive the run context** (`AuditRunInput`) from the `$PIPELINE_RITE_AUDIT_STAGE_ADAPTER` `runHook`.
   Confirm `baseUrl` and `reviewerFixture` are present; abort loudly if not (never fabricate them).
2. **Preflight the gate.** Navigate `${baseUrl}$RITE_REVIEW_ROUTE` as the reviewer fixture; if it 404s, the
   flag-force seam (the repository flag-force record) is broken — record a BLOCKED precondition and stop the functional
   rite (it cannot run without the gate open).
3. **Run each active dimension** in order ([`DIMENSIONS.md`](./DIMENSIONS.md) §Running a
   dimension), driving the Playwright MCP per that dimension's file. Each emits a
   `DimensionResult` (PASS iff every `Finding` is PASS; any FAIL **or** BLOCKED ⇒ FAIL).
4. **Emit the raw findings bundle** — the union of every dimension's `Finding`s, with the
   per-dimension `DimensionResult` status. This is the explorer's output. **Hand it to the
   verdict report (the repository verdict-report record)** for structuring/archiving; do not format the dated archive here.

## Never silently pass — the load-bearing invariant (the failure-visibility invariant)

A transition that **cannot be evaluated** — a surface that 404s when it should resolve, a step
whose precondition failed, a click that produced no observable change — is **never** recorded
as PASS and **never** dropped. It is recorded as a `Finding` with status FAIL (or BLOCKED, which
rolls up to FAIL at the dimension level). The whole point of the audit is to make a broken rite
*unmistakable*; an unevaluated check that quietly disappears would defeat it. When in doubt
between PASS and "couldn't tell", it is **not** PASS.

## Scope — what this skill does not do

- It does **not** deploy, seed, mint, or destroy the stage — that is `$PIPELINE_RITE_AUDIT_STAGE_ADAPTER` (the repository audit-stage record).
- It does **not** run against production — only a flag-on configured audit deployment class stage (the flag is a public
  release switch; the repository deployment/release decision).
- It does **not** structure or archive the dated verdict — it emits raw findings; the repository verdict-report record archives.
- It does **not** implement the a11y or sandbox-leak dimensions — those are the repository accessibility record / the repository containment-audit record, added
  per the [`DIMENSIONS.md`](./DIMENSIONS.md) contract.
