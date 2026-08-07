---
name: triage
description: Turn one raw intake issue into a single actionable unit a builder can pick up cold — classified, enriched from the code it is about, priced, and stamped. Trigger on "/triage", "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", and whenever someone asks to make the backlog actionable or pickable. This is the guardrail between raw intake and pickable work: nothing reaches a builder without passing through here, so a wrong-but-well-formed classification written here travels downstream unchallenged. Done when the issue carries exactly one type, one priority, and the triaged stage — or has left the queue parked for a human or killed as an agent filing.
---

# triage

You are the guardrail. **The failure that matters is not a missing label — it is a confident wrong
one**, which is indistinguishable from a correct one once it lands and is trusted by everything
downstream. Every step below ends in something you can check rather than something that merely
looks complete.

You have full rewrite authority. **Salvage first**: enrich an unclear issue before you judge it.

## 1 — Claim it before you mutate it

```bash
pipeline cli tracker claim 4312
```

Sweeps run concurrently. Two sessions that both picked this issue off the same listing will both
rewrite its body, and the second write silently wins with no error.

Done when it printed `claimed`. On `held-by-other` or `lost`, move to the next issue and do not
mutate this one.

## 2 — Read the issue, then read the code it is about

Never classify from the title. Read the body, then read enough of the repo to state in your own
words what this is about. **Check any falsifiable claim it rests on against the source** before you
enrich on top of it — a description of how something behaves is not that behavior.

A hand-filed issue never ran a dedup check, so run one now — same verb and same three outcomes the
`report` skill documents, plus `--exclude` so the issue never flags itself:

```bash
pipeline cli intake-dedup check --query "editor loses focus after save" --exclude 4312
```

Read the candidates yourself; shared vocabulary is not a shared observation. A genuine duplicate
routes by who filed it (step 6).

Done when you can state the issue from the code, and the dedup outcome has been read from stderr.

## 3 — Classify into exactly one of six types

| Type | The issue is this when… |
|---|---|
| `bug` | **Behavior diverges from intent.** Something built does the wrong thing; a "supposed to" is violated. |
| `feature` | **A new capability, directly implementable.** It does not exist, the path is clear, it fits in a PR or a few. |
| `chore` | **No behavior change.** Refactor, rename, dep bump, doc edit — observable behavior is identical after. |
| `decision` | **One question; the output is a recorded choice.** The deliverable is "we decided X", not "we built X". |
| `investigation` | **An unknown; the output is knowledge.** You cannot say what to build because nobody knows what is wrong. |
| `epic` | **Too big for one PR; it spawns children.** The deliverable is a plan plus sub-issues. |

The three boundaries that actually bite:

- **decision vs epic** — one question is a decision; many, or questions plus buildable children, an epic.
- **bug vs investigation** — a nameable fix is a bug. An investigation whose answer *might* prove
  trivial stays one; re-typing in anticipation throws away the fact that nobody knew yet.
- **feature vs epic** — judge the *real* deliverable. **Do not invent a v1 scope to make an epic fit
  a PR**; if you must carve the work down to call it a feature, it is an epic and your carve-out is
  its first child. The tells: missing prerequisite infrastructure, a capability implying surfaces
  nobody has built, and your own hedging — "if this balloons, split X out" is the boundary talking.

Done when one type holds and you can name the question that excluded its nearest neighbour.

## 4 — Split a bundle into single units

Two problems that different agents could work at different times are a bundle. Two facets of one
change are not. Guard against re-creating a child, then file each extra unit:

```bash
pipeline cli split-guard check --parent 4312 --title "Editor loses focus after save"
pipeline cli tracker create-issue --title "Editor loses focus after save" <<'EOF'
split from #4312
…
EOF
```

`split from #<parent>` is the create-once key the guard reads — load-bearing, not decorative. Each
child re-enters the queue and is triaged like any other issue.

**A human-filed original always stays one of the units.** Only an agent filing may be left an empty
husk and killed: a husk parked for a human is a question nobody can answer.

Done when every unit is separately pickable.

## 5 — Enrich: rewrite on top, original preserved beneath

Rewrite the body so a builder can act on it, keeping the original verbatim beneath in a `<details>`
block titled `Original report (verbatim)`. The rewrite trades vague framing for real paths and
function names, and adds acceptance criteria that make "done" legible — a seed a review gate may
append to, not a closed set.

**No invention.** Enrich from what you found, keep the uncertainty the original had, and mark your
own reads `Triage note:`. Scope-shrinking is invention too.

**Repo-relative paths only**, in the rewrite *and* the preserved original. Redact a machine-local
path rather than reproducing or dropping it — masking keeps the evidence one was posted:

```bash
pipeline cli redact-leaks --body-file <the original body>
```

**An epic is wrapped in place, never rewritten over.** Its content is the brief the planner reads,
so nothing goes above it: collapse it into `<details>` titled `Original brief (verbatim)` and stop.
On a **re-type, rewrite the criteria to the new type** — old criteria under a comment explaining the
new one ship a spec that contradicts itself.

> **No verb backs this step** (`contract.md` G1): the edit goes through `gh api`, so nothing checks
> the original survived or that paths stayed repo-relative. Check it yourself.

Done when every claim in the rewrite traces to something you read.

## 6 — The two outcomes that are not "triaged"

Provenance decides what may be closed, and provenance is the `Filed by an agent` footer, not
authorship — every filing carries the same author. Read the body's footer:

- **No footer** ⇒ hand-typed by a human ⇒ **protected**. If you cannot act on it, park it: comment
  the specific questions that would unblock triage and stamp the needs-info stage. **Never close
  it.** When in doubt, treat it as human — ignoring a person costs more than a cheap agent issue.
- **Footer present** ⇒ agent-filed ⇒ closable, but only once salvage genuinely failed. A duplicate
  is killed by first folding its content into the survivor, then closing; without that fold the
  content is simply lost. A human-invoked `/report` carries the same footer, so footer presence
  alone never licenses a close.

Done when the issue has left the queue by exactly one route.

## 7 — Price it and stamp it

Price on the work's own merit: `p0` for fires and work that ships value, `p1` for what you would
genuinely pull next, and **`p2` is the default** and most of a healthy backlog. When torn between
`p1` and `p2`, take `p2` — an inflated `p1` set is what makes a backlog unsequenceable.

```bash
pipeline cli tracker apply-triage 4312 --type bug --p p2
```

This applies the type, the priority, and the triaged stage, and drops the issue out of the intake
queue in one call. Pass `--status` only to reach a different stage, such as parking a human issue.

**Do not assert control-plane scope here.** The path classifier routes it downstream; a lane
asserted at triage routes around an approval that then never fires.

Done when the verb read back exactly one type, one priority, and the stage you intended.

## Sweeping the queue

Work one issue fully — claim through stamp — before starting the next, and re-list at the end: new
issues land mid-sweep. **Only a proven-empty queue ends a sweep**; a failed read is a different
answer and is never "empty".

Report one line per issue — outcome, type, priority — using **repo-relative paths only**.
