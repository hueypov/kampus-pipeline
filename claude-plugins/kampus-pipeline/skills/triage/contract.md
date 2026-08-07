# triage — contract

What the `triage` skill must do, stated so it can be checked. `evals/evals.json` is the executable
form; a change here without a matching eval is a change nobody can verify.

## Purpose and boundary

`triage` is the guardrail between raw intake and pickable work. It turns one raw issue into a single
actionable unit a builder can pick up cold, or removes it from the queue by exactly one other route.

It **does not** plan an epic into children (`plan-epic`), implement (`write-code`), review, or merge.
It also never creates the homes it assigns into — curating those is a human act.

The failure mode this skill exists to prevent is not an unlabeled issue. It is a **confident wrong
label**, which is byte-identical to a correct one and is trusted unchallenged by every stage after.

## Invocation axis

**Model-invoked.** Triage is dispatched by an orchestrator and by an agent noticing the queue has
grown, not only by a human typing its name. It keeps its description.

## Invariants

**T1 — Claim before mutate.** No read is a mutation, but every write follows a won claim. Two
concurrent sweeps that both rewrite a body produce a silent last-write-wins loss, not an error.

**T2 — Never classify from the title.** The body is read, and the code it is about is read, before a
type is chosen. Any falsifiable claim the issue rests on is checked against source before enrichment
builds on top of it.

**T3 — Exactly one type.** One of `bug`, `feature`, `chore`, `decision`, `investigation`, `epic`. The
run can name the question that excluded the nearest neighbour.

**T4 — A bundle is split into separately pickable units.** Two facets of one change are not a
bundle. Each child carries `split from #<parent>`, which is the create-once key the split guard
reads, not a decoration. **A human-filed original always remains one of the units** — only an agent
filing may be reduced to an empty husk and killed.

**T5 — Enrichment rewrites on top and preserves the original verbatim beneath**, in a `<details>`
block. The rewrite is what a builder reads; the original is the provenance record.

**T6 — An epic is wrapped in place, never rewritten over.** Its original content is the brief the
planner consumes; anything written above it forks that input.

**T7 — No invention.** Enrichment comes from what was read. Uncertainty in the original is
preserved rather than resolved by assertion, and the run's own reads are marked as such.
Scope-shrinking is invention: carving an epic down to feature size is not a classification.

**T8 — Repo-relative paths only**, in the rewrite *and* in the preserved original. A machine-local
path in the original is redacted to its class, never reproduced and never silently dropped.

**T9 — A re-type rewrites the acceptance criteria.** Criteria written for the old type, under a
comment explaining the new one, ship a spec that contradicts itself.

**T10 — A human-filed issue is never auto-closed.** Provenance is the `Filed by an agent` footer,
not authorship. No footer means hand-typed and protected; an unactionable human issue is parked with
specific questions, never killed. When provenance is ambiguous, treat it as human.

**T11 — A kill folds content before closing.** Killing a duplicate without first folding its unique
content into the survivor loses that content permanently. Footer presence alone never licenses a
close — a human-invoked report carries the same footer.

**T12 — The stamp is exactly one type, one priority, and the intended stage**, and the issue leaves
the intake queue. Priority defaults to the lowest band; ties break downward.

**T13 — Only a proven-empty queue ends a sweep.** A failed read is UNKNOWN and is never "empty".

## Verb surface it depends on

| Verb | Role |
|---|---|
| `pipeline cli tracker claim <n>` | Marker-based claim; exit 0 and `claimed` means this session holds it |
| `pipeline cli intake-dedup check --query <q> --exclude <n>` | Candidate duplicates, excluding the issue under triage |
| `pipeline cli split-guard check --parent <n> --title <t>` | Prints an existing child covering (parent, title), else nothing |
| `pipeline cli tracker create-issue --title <t>` | Files a split child; body on stdin |
| `pipeline cli tracker create-comment <n>` | Park questions, fold notes, triage rationale; body on stdin |
| `pipeline cli tracker apply-triage <n> --type <t> --p <p> [--status <s>]` | Applies type, priority and stage, and drops the queue label, in one call |
| `pipeline cli redact-leaks --body-file <f>` | Masks machine-local paths in a preserved original |

The claim is **comment-marker based, not assignee-based**. That matters downstream: `write-code`
skips issues with a non-null assignee, so a triage claim does not make an issue unpickable. It does
block a *later re-triage* by a different session, which is what G2 is about.

## Known gaps in the deterministic layer

**G1 — Step 5 has no verb.** Enrichment — the rewrite-on-top, the verbatim preserve, the epic
wrap-in-place, the leak redaction of the original — currently goes through `gh api` directly.
Nothing verifies that the original survived, that the `<details>` block is well-formed, or that
paths are repo-relative. This is the largest step in the skill and the only completely unguarded one.
T5–T8 all rest on it. `tracker` should own an `enrich` verb that takes the rewrite on stdin,
composes the preserve block itself, and refuses a body that lost the original.

**G2 — There is no claim-release verb.** `tracker` has `claim` and `read-back` but nothing that
drops a claim. An issue triaged in one session carries that claim forever, so a later session
re-triaging it backs off at step 1 and cannot proceed. The claim is a sweep-scoped mutex being used
as if it were permanent ownership.

**G3 — `apply-triage` has no audience flag.** *Ready* and *ready for whom* are different questions:
a `decision`, an authoring brief, or anything resting on a product call nobody has made is ready,
but not ready for an agent. Without the distinction, work written for a human lands in a builder's
candidate pool. This is the one advance in the reference implementation that has no equivalent here.

**G4 — There is no kill verb.** `graduate` closes a source as *completed*, which is the wrong state
for an unsalvageable filing. Closing not-planned with an audit marker has no CLI path, so T11 is
carried entirely by prose.

**G5 — Homing is neither decided nor configurable.** `github.triage` carries only `enabled` and
`queueQuery`. The reference implementation requires every triaged issue to leave with a home — a
milestone or one of two standing lanes — because un-homed issues make milestone counts lie. That is
a real problem and a repo-specific answer: a fresh repo has no milestones, and a general-purpose
pipeline must not invent two lane names for everyone. Homing therefore belongs in policy: a
`homing` block declaring whether a home is required and what the lanes are, with the requirement
skipped entirely when the block is absent. Until that exists, this skill assigns no home, and the
step is deliberately absent rather than hardcoded to somebody else's doctrine.

**G6 — Provenance is read by hand.** T10 — the single invariant protecting a human's issue from
being auto-closed — is enforced by asking the run to look for a footer string in the body. It should
be a verb returning `human` or `agent`.

## Out of scope

Planning an epic into children, implementing, reviewing, merging, and creating milestones.
