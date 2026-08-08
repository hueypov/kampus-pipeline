---
name: triage
description: Turn one raw intake issue into a single actionable unit a builder can pick up cold — classified, enriched from the code it is about, priced, and addressed to whoever picks it up. Trigger on "/triage", "triage the queue", "triage issue #N", "process needs-triage", "classify these issues", and whenever someone asks to make the backlog actionable or pickable. This is the guardrail between raw intake and pickable work: nothing reaches a builder without passing through here, so a wrong-but-well-formed classification written here travels downstream unchallenged. Done when the issue carries exactly one type, one priority, an audience and the triaged stage — or has left the queue parked for a human or killed as an agent filing.
---

# triage

You are the guardrail. **The failure that matters is not a missing label — it is a confident wrong
one**, which is indistinguishable from a correct one once it lands and is trusted by everything
downstream. Every step below ends in something you can check.

You have full rewrite authority. **Salvage first**: enrich an unclear issue before you judge it.

## 1 — Claim it before you mutate it

```bash
pipeline cli triage claim 4312
```

Sweeps run concurrently. Two sessions that both picked this issue off the same listing will both
rewrite its body, and the second write silently wins with no error.

Done when it exits 0. On exit 3 another session holds it — take the next issue.

## 2 — Read the issue, then read the code it is about

Never classify from the title. Read the body, then read enough of the repo to state in your own
words what this is about. **Check any falsifiable claim it rests on against the source** before you
enrich on top of it — a description of how something behaves is not that behavior.

A hand-filed issue never ran a dedup check, so run one now:

```bash
pipeline cli report dedup --query "editor loses focus after save" --exclude 4312
```

Read candidates yourself; shared vocabulary is not a shared observation. Exit 3 is
`indeterminate` — a non-check — so re-query. A genuine duplicate routes by provenance (step 6).

Done when you can state the issue from the code and the dedup outcome is a real answer.

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

Two problems different agents could work at different times are a bundle. Two facets of one change
are not.

```bash
pipeline cli triage split 4312 --title "Editor loses focus after save" <<'EOF'
…
EOF
```

The verb writes the back-reference and refuses to create a second child for a unit it already made,
so a retry reuses rather than duplicates.

**A human-filed original always stays one of the units.** Only an agent filing may be left an empty
husk and killed: a husk parked for a human is a question nobody can answer.

Done when every unit is separately pickable.

## 5 — Enrich: rewrite on top, original preserved beneath

```bash
pipeline cli triage enrich 4312 <<'EOF'
…
EOF
```

Your rewrite goes on stdin; the verb preserves the original beneath it and refuses if it does not
survive the round trip. Pass `--redact` when the original holds a machine-local path — masking keeps
the evidence one was posted.

The rewrite trades vague framing for real paths and function names, and adds acceptance criteria
that make "done" legible — a seed a review gate may append to, not a closed set.

**No invention.** Enrich from what you found, keep the uncertainty the original had, and mark your
own reads `Triage note:`. Scope-shrinking is invention too. **Repo-relative paths only.**

**An epic is wrapped in place** — `--epic` with empty stdin. Its content is the brief the planner
reads, and anything above it forks that input. On a **re-type, rewrite the criteria to the new
type**; old criteria under a comment explaining the new one ship a self-contradicting spec.

Done when every claim in the rewrite traces to something you read.

## 6 — The two outcomes that are not "triaged"

```bash
pipeline cli triage provenance 4312
```

`human` (exit 3) or `ambiguous` (exit 5) means hand-typed and **protected** — park it with the
specific questions that would unblock triage. Park never closes, and nothing makes it. When in doubt
treat it as human: ignoring a person costs more than a cheap agent issue.

```bash
pipeline cli triage park 4312 <<'EOF'
…
EOF
```

`agent` (exit 0) is closable, but only once salvage genuinely failed. `--confirm` is **you attesting
that** — footer presence alone never licenses a close, since a human-invoked report carries the same
footer. `--duplicate-of` folds this issue's content into the survivor first; without it that content
is lost.

```bash
pipeline cli triage kill 4312 --confirm --duplicate-of 4290 <<'EOF'
…
EOF
```

Done when the issue has left the queue by exactly one route.

## 7 — Price it, address it, stamp it

Price on the work's own merit: `p0` for fires and work that ships value, `p1` for what you would
genuinely pull next, **`p2` is the default**. Torn between `p1` and `p2`, take `p2` — an inflated
`p1` set is what makes a backlog unsequenceable.

**Then decide who picks it up.** `--ready-for agent` when the work is specified well enough to
execute cold; `--ready-for human` when the deliverable is a judgment — a `decision`, an authoring
brief, anything resting on a call nobody has made. Get it wrong and work written for a person lands
in a builder's candidate pool.

```bash
pipeline cli triage apply 4312 --type bug --priority p2 --ready-for agent
```

Where the repository requires homing the verb refuses with exit 6 until you pass `--home` or
`--lane`. It never creates a milestone — take an existing one.

Done when the verb reads back exactly what you intended.

## 8 — Release the claim

**Every outcome releases**, park and kill included. A triage hold is scoped to the sweep; one left
behind means nobody can re-triage that issue.

```bash
pipeline cli triage release 4312
```

## Sweeping the queue

```bash
pipeline cli triage queue
```

Work one issue fully — claim through release — before starting the next, and re-list at the end:
issues land mid-sweep. **Only `empty` ends a sweep.** A failed read is exit 4 and a different
answer entirely.

Report one line per issue — outcome, type, priority, audience — **repo-relative paths only**.
