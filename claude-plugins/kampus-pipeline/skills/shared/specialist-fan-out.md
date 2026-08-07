# Specialist fan-out, and route-don't-grade — the shared reference

The shared mechanism the four review gates use to catch a real defect the acceptance criteria never
named, without turning a focused gate into a nitpick firehose.

**This file is the citable home.** `review-code`, `review-doc`, `review-skill` and `review-plan`
wire the same behavior into their own artifact classes by citing this file — not by re-deriving the
dimensions, the routing decision, or the append. One logic, four call sites; only the diff each gate
already loaded and the class it verifies differ.

## The blind spot it closes

The acceptance-criteria checklist catches what the issue *named*. It is structurally blind to a
real, in-scope defect the criteria never named — a swallowed fault, a dropped invariant, a
behavioral path nobody tested — because there is no open-ended correctness sweep.

That blindness is deliberate: an unbounded "find anything wrong" pass produces a firehose that
buries the criteria the gate exists to check. The fan-out is the bounded alternative. It routes such
a finding back into **the one mechanism the loop already drains — the criteria checklist** — rather
than onto a parallel severity track nobody converges on.

## Fan out over the diff you already loaded

Run the specialists over the diff the gate already pulled. The fan-out adds **no second checkout and
no extra API cost**, and each dimension is a **checklist line within the single review pass, not a
separately spawned agent** — a line reuses the loaded context for free, where an agent pays a whole
orchestration round.

The starting dimensions are three:

- **silent-failure** — a swallowed error, an empty catch, a discarded failure channel, a result
  whose error path is dropped. A fault the diff makes *unobservable at runtime*.
- **type-design** — a representable invalid state, a widened type that admits what the domain
  forbids, an invariant the types stopped enforcing.
- **test-gap** — a behavioral path the diff adds or changes that no test exercises. Coverage the
  criteria did not name but "make this work" implies.

A dimension **graduates** to its own agent only on evidence it cannot hold the rigor as a line —
filed as an observation when that happens, not assumed up front.

Each dimension produces zero or more **findings**: a concrete defect with its site in the diff. The
fan-out feeds findings into the routing step. **It does not itself emit a verdict.**

## Route, don't grade

A finding is **routed, not graded**. There is no severity tier and no confidence score — grading
invites a reviewer to log a worry it will not stand behind, and a worry with a severity attached
still costs the author a round. The decision is one binary:

**In-scope** — the finding traces to the linked issue's stated goal. Route it by **appending a new
acceptance criterion** to that issue, using the reviewer-append surface in
[`../gh-issue-intake-formats.md`](../gh-issue-intake-formats.md). That file owns the checkbox shape,
the provenance tag, and the fences — cite it, do not restate it here, or the two drift.

**Out-of-scope** — the finding is real but does not trace to *this* issue's goal: a tangential
defect, an adjacent refactor, a pre-existing bug the diff merely made visible. File it through
[`../report/SKILL.md`](../report/SKILL.md) as fresh intake, where it re-enters on its own merits.
**The current PR is not blocked by it.** Blocking a PR on a defect its issue never scoped is how a
gate becomes something authors route around.

The test is the same trace-to-stated-goal test planning already applies when it checks story
coverage — one test, used twice, so a finding cannot be in-scope for the gate and out-of-scope for
the plan.

## Why appending beats a parallel track

An appended criterion is drained by the mechanism that already exists: the author fixes it, the gate
re-checks it at the next head, and the loop converges. A finding logged as an advisory note on a
second track has no drain — nothing re-reads it, nothing closes it, and it accumulates until the
notes are skimmed rather than read.

So the append is not a formatting preference. It is what makes the finding *land*.

## The bound that keeps it honest

The append surface is **append-only, in-scope-only, and frozen after the repair cap**. Past that
cap, a reviewer that keeps discovering new in-scope criteria is no longer gating a diff — it is
rewriting the issue underneath the author, and the loop stops terminating. At the cap, the finding
goes out as fresh intake like any other out-of-scope one, and the PR escalates to a human.
