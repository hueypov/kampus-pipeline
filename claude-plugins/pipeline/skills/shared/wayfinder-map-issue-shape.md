# The map issue shape — the ideation-layer contract

The single source for the body shape of a `wayfinder:map` issue: its four sections and their order,
the origin attribution every decision entry carries, and the lockstep rule that moves a ticket off
the frontier.

**Who reads it.** The `wayfinder` skill's chart and work modes, and the `wayfinder-map` CLI verb.
Both cite this file; neither re-derives it. Anything else that names the shape points here rather
than restating it.

## What a map is

A map issue is not a task and not an epic. It is a **living map** — the ideation-layer surface that
sits *upstream* of intake, where a destination is still fuzzy and the work is to clear enough fog to
hand a concrete plan to planning.

It is a **shared state contract, not free prose**. Its four sections are the durable seam between
runs, so a `work` run months later picks up cold from what a prior run left behind. The *why* lives
in the `wayfinder` skill; this file is the shape.

## The four sections, in order

**`## Destination`** — the named end-state, in one or two sentences, concrete enough to tell
"arrived" from "not yet". This is the fixed star the map steers by. It changes rarely, and only in
chart mode.

**`## Decisions-so-far`** — the accreting answer log: settled decisions and established facts,
newest last, one line each, naming what was decided and where it came from. This is the map's
growing spine of certainty. **Nothing is ever deleted here** — a decision later revisited gets a new
superseding entry, so the log stays auditable rather than becoming a summary of the current
position.

**`## Open frontier`** — the live edge of the unknown: the open investigation and decision tickets
whose answers would clear the next stretch of fog. This is the only section that says what to do
next.

**`## Graduated fog`** — the cleared unknowns: tickets whose answers have been recorded in
Decisions-so-far. Keeping them visible is what stops a later run re-asking a settled question.

## Every decision entry carries its origin

Each `## Decisions-so-far` entry ends with a resolvable origin — `— from #N`. Which number depends
on how the entry got there:

- **A work-mode append** cites the **frontier ticket it resolved**.
- **A chart-time seed** — a given brought in at charting, or a ruling recorded mid-run — has no
  frontier ticket to cite, so it is attributed to **the map's own issue number**. The seed came from
  the chart act that created the map, so the map is its honest origin, and the entry stays
  resolvable without inventing an unattributed form.

An entry with no origin is not auditable: a future run cannot tell a settled decision from an
assumption someone typed, which is exactly the confusion the log exists to prevent.

## The lockstep rule

**A ticket leaves the frontier only in the same act that records its answer.** Moving it to
Graduated fog and appending to Decisions-so-far happen together, never one without the other.

Half of that pair alone produces a map that lies in one of two directions: a graduated ticket with
no recorded answer reads as settled when nothing was learned, and a recorded answer whose ticket
still sits on the frontier sends the next run to re-resolve a question that is already closed.

## The one seam that is never automatic

A fork that only the owner of the direction can settle is **surfaced, never resolved**. A map run
that reaches one stops, states the fork, and leaves it on the frontier. Deciding it on the map's own
authority is how a product direction gets set by whichever agent happened to run that day.

## Worked example

```markdown
## Destination
Contributors can install the pipeline in a repo that is not this one and reach a first
merged PR without hand-editing a skill.

## Decisions-so-far
- Distribution is a pinned submodule, not npm — from #12
- The stage vocabulary is repo-owned config, not literals in skill prose — from #34
- Homing is optional and policy-driven; a repo with no milestones skips it — from #41

## Open frontier
- #52 Investigation: what does a fresh repo need before the first triage run?
- #57 Decision: does the merge gate require a queue, or is auto-merge enough?

## Graduated fog
- #34 Decision: where does the stage vocabulary live? → answered, see above
- #41 Decision: is homing required for every triaged issue? → answered, see above
```
