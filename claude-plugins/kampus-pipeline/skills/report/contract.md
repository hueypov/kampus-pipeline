# report — contract

What the `report` skill must do, stated so it can be checked. `evals/evals.json` is the executable
form of this document; a change here without a matching eval is a change nobody can verify.

## Purpose and boundary

`report` turns an observation made mid-task into a durable, triageable issue, and returns the agent
to what it was doing. It is the pipeline's intake seam.

It **does not** classify, prioritize, split, fix, close, or assign. Every one of those is a later
stage's job, and doing any of them here corrupts the signal `triage` runs on.

## Invocation axis

**Model-invoked** — it keeps its `description` and pays the context cost on every turn. This is the
one setting that works: the skill's whole value is firing *unprompted*, the instant an agent
notices something. A user-invoked `report` could only be reached by a human who already decided to
file, which is the case that needed no skill.

## Invariants

Each is a claim the skill must satisfy, numbered so an eval can cite it.

**R1 — Exactly one lifecycle stage, no classification.** A filed issue enters at `needs-triage` and
carries no type, no priority, and no severity language in its metadata. A hand-applied
classification is indistinguishable downstream from a triaged one.

**R2 — Six sections, all present.** `Summary`, `What I was doing`, `What I observed`, `Why it
matters`, `Pointers`, `Suggested next step`. Only the last may be empty. The set is type-blind by
design: the same six fit a crash, a refactor, and a question, which is what lets an agent file
without first deciding which it is.

**R3 — The summary leads and does not replace.** `## Summary` is prose a reader grasps on a skim,
and it precedes the structured sections rather than substituting for them.

**R4 — Title is specific and type-neutral.** It names the observation. It does not carry a type
prefix (`BUG:`, `FEAT:`), a priority, or a prescribed fix.

**R5 — One observation, one issue.** Two separate things noticed are two filings. Bundling is a
cost paid by triage, which must then split it.

**R6 — No machine-local paths.** No `/Users/…`, no `~/…`, no sibling-clone path, in the body or the
title. Paths are repo-relative or they are not written. When a local path is the evidence itself,
it is redacted to its class, never posted raw.

**R7 — Dedup runs after composition, immediately before filing.** Checking first and composing
second widens the window in which a concurrent run files the same thing.

**R8 — An unread check is never a clean check.** A non-zero exit, or a query with no usable
keywords, means the check did not run. Neither may be reported or acted on as "no duplicate found".

**R9 — Ambiguity files.** When the candidates are genuinely unclear, file. A duplicate costs triage
seconds; a dropped observation is unrecoverable.

**R10 — A refusal is corrected, never routed around.** When a verb refuses, the input is fixed and
the verb re-run. Reaching for a different posting mechanism is how a body gets replaced by a path
to the body.

**R11 — The skill returns.** After reporting the number and URL, the agent resumes the interrupted
task. It does not continue into triaging or fixing what it just filed.

**R12 — Every filed issue carries the provenance footer.** The `Filed by an agent` footer is
appended after the sections and a blank line, on every filing, without exception. This is a
*cross-skill* invariant, not a formatting preference: `triage` keys auto-close eligibility on
footer presence — present means agent-filed and therefore closable, absent means hand-typed and
therefore protected. A filing without one is permanently misread as a human's and can never be
killed, which silently fills the backlog with un-closable agent noise. The footer carries machine
context only — session, branch, timestamp — never identity and never paths.

## Verb surface it depends on

| Verb | Role |
|---|---|
| `pipeline cli intake-dedup check --query <text>` | Candidate duplicates on stdout, count and diagnostics on stderr |
| `pipeline cli tracker create-issue --title <t>` | Files the issue; body on stdin; `--stage` defaults to `needs-triage` |
| `pipeline cli tracker create-comment <n>` | Adds a note to an existing issue; body on stdin |
| `pipeline cli redact-leaks` | Masks machine-local paths to their class, preserving evidential shape |

Body-on-stdin is load-bearing, not stylistic: it means there is no shared temp file two concurrent
runs can collide on, and no `@path` argument form that could post a path where the contents were
intended.

## Known gaps in the deterministic layer

The governing rule is that deterministic work belongs in a typed verb, not in prose an agent must
remember. These are the places `report` currently violates it. Each is a defect to close, and until
closed, an invariant carried by judgment alone — which is exactly the weakest place to carry one.

**G1 — `create-issue` does not refuse a machine-local path.** `post-verdict` validates its body and
fails closed before writing; `create-issue` does not. So R6 rests entirely on the agent noticing.
The fix is to move that same validation into the create path, so a leak is refused rather than
prevented by vigilance.

**G2 — `create-issue` does not refuse an empty or section-incomplete body.** An unread stdin pipe is
byte-identical to an empty one, so a body that never arrived files as a successful, bodyless issue.
R2 should be enforced by the verb.

**G3 — `intake-dedup check` conflates "none" with "not checked".** Both exit 0 and both print
nothing on stdout; only a stderr string distinguishes them. R8 is therefore enforced by asking the
agent to read stderr carefully — a guarantee no exit code backs. The outcomes should be distinct
and machine-readable.

**G4 — The intake-queue label is a hardcoded literal.** `intake-dedup` defaults `--label` to
`status:needs-triage` in source, bypassing the repository's configured stage vocabulary. Any repo
whose stages are named differently gets a check that silently matches nothing.

**G5 — The provenance footer is appended by the caller, not the verb.** R12 is a cross-skill
invariant enforced by asking an agent to remember a second command in a compound shell block — the
weakest possible enforcement for the strongest possible consequence, since a forgotten footer is
invisible at filing time and only surfaces later as an issue triage cannot close. `create-issue`
should compose and append it, so a filing without one is unrepresentable rather than merely
discouraged. Composition also lets the verb drop unavailable fields cleanly, which the shell
script already does but no caller can verify.

## Out of scope

Classification and priority (`triage`), splitting bundles (`triage`), planning (`plan-epic`),
implementation (`write-code`), and closing (`triage` or `ship-it`). `report` files and returns.
