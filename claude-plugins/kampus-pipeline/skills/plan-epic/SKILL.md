---
name: plan-epic
description: Turn one triaged epic into a plan a fleet can execute without you — a PRD-grade plan written into the epic body, a set of sub-issues that each trace to a user story and carry their own acceptance criteria, and a pinned dependency topology saying what gates what. Trigger on "plan the epic", "plan epic #N", "break down the epic", "/plan-epic", or whenever a triaged `type:epic` issue has no plan. Done when the ledger validates and the lock is released. Never for an untriaged issue, and never for one that is not an epic.
---

# plan-epic

You turn one epic into work other agents can pick up cold. Everything downstream reads what you
write and nothing re-derives it, so a plan that is merely plausible costs more than no plan.

**Two things here are yours and nothing else can do them:** deciding what the epic is really for,
and deciding where the seams between children fall. The rest — the lock, the child shape, the
topology check, the write — is mechanical, and the verbs below own it.

You are **autonomous**. A human already approved the epic at triage; you do not interview, propose
first, or wait for sign-off.

## 1 — Take the lock

```bash
pipeline cli epic-lock acquire 412
```

`plan-epic` and `review-plan` both mutate one epic's children. Run concurrently they interleave and
leave a ledger neither wrote. Exit 0 means it is yours; anything else means **back off and change
nothing** — not even a label.

**Release it on every exit, including failure** (step 6). A lock you took and did not release makes
the epic unplannable by anyone.

## 2 — Ground the plan, then write it

Read the brief and read enough of the codebase to know what the epic is actually about. A plan
written from the title alone reads fine and sends a fleet at the wrong thing.

Then write the plan **product layer first**:

1. **The problem** — whose, and what is true today that shouldn't be.
2. **The solution from the user's side** — what changes for them, not what you will build.
3. **User stories, numbered.** These are the spine. Every child traces to one, so a story you cannot
   name is work you cannot justify.
4. **Testing strategy** — how anyone will know it worked.
5. *Then* the engineering layer: approach, and why the split falls where it does.

A plan that opens with architecture says *how* without ever saying *who needs this*. That is the
half-plan this stage exists to not produce.

**When a story turns on a product decision you cannot ground in the codebase, carve it as a
`decision` child.** Do not resolve it yourself and do not write around it — an invented answer
propagates to every agent that reads the plan, and none of them will know it was invented.

## 3 — File the children

One verb per child. It refuses a child that is not pickable rather than filing one that is:

```bash
pipeline cli plan-epic child 412 --title "Extract the retry helper" --stories 2,4 --type chore <<'MD'
### What to build
…

### Acceptance criteria
- [ ] …
MD
```

Two invariants it enforces, both of which exist because the failure is silent:

- **Every child carries at least one acceptance criterion.** A child without one is picked up, and
  the agent that picks it decides for itself what "done" meant.
- **Every child traces to at least one story.** Untraced work is work nobody agreed to.

**You classify each child yourself** — that is what `--type` is. A plan child is born triaged, not
queued for triage: you have read the codebase under a lock and already made the call, and sending it
back through intake asks a triager to re-derive it. **No child is an epic.** If one would be, your
plan stopped early.

It is **create-once** on `(epic, title)`, so re-running after a partial failure resumes rather than
duplicating. Filing the same child twice is the specific damage a re-run causes.

### Sizing a child

Each one is a **tracer bullet**: end to end and thin, not a layer. "Add the endpoint" and "add the
UI" are two halves of one thing nobody can verify separately; "one user can save one bookmark and
see it" is a child. If you cannot state a child's acceptance criteria without referring to another
child's output, you have cut along the wrong seam.

## 4 — Pin the topology

Write a `## Dependencies` block: `### Phase N` headings are the sequence, the list inside a phase is
what can run in parallel, and `requires: #N` is an edge across a phase boundary.

**Topology only.** Retry budgets, concurrency caps, and agent counts are an orchestrator's business
and change per run; what gates what is a property of the work.

## 5 — Write it, then prove it

```bash
pipeline cli plan-epic write 412 --plan-file plan.md --deps-file deps.md
pipeline cli epic-ledger 412 --dry-run
```

`write` appends below the brief and **never rewrites on top of it** — the brief is your input and
somebody else's record. It reads the body back and refuses if the brief did not survive byte for
byte, so a lost brief is a failure rather than a silent overwrite.

`epic-ledger --dry-run` is the same structural gate `review-plan` will run. Run it yourself: a
cycle, an edge to a child that does not exist, or a child in no phase is a defect you can still fix
while you hold the lock.

**Chain it.** `--dry-run` exits 0 on PASS and 14 on FAIL, so `&&` after it means what it looks like
it means. The defect list on stdout tells you what to fix.

**A ledger that does not validate is not a plan.** Fix it or park the epic — do not release into a
state a fleet will start executing.

## 6 — Release, and report

```bash
pipeline cli epic-lock release 412
```

Then one line: the epic, the children you filed, and whether the ledger validated. Stop there. You
do not implement a child, and you do not review your own plan.

## What you never do

- **Never plan an untriaged issue, or one that is not an epic.** Triage decided that; re-deciding it
  here means two stages disagree and neither knows.
- **Never rewrite the brief.** Append below it. Even to fix it.
- **Never file a child you could not give acceptance criteria.** File the `decision` child that
  would let you.
- **Never leave the lock held.** Failure paths especially.
- **Never treat a ledger you could not validate as validated.** Unread is not clean.
