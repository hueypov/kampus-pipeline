---
name: write-code
description: Turn one triaged issue into a pull request, end to end — claim it, implement it on a branch, open a PR that closes it, log what you did, and hand the gate to an independent reviewer. Also runs repair mode: given a PR whose review FAILed, consume the findings and fix-and-resubmit on the same branch. Trigger on "work the next issue", "pick up an issue", "implement issue #N", "/write-code", "repair PR #N", "fix the FAIL on #N", or whenever triaged work needs turning into a PR. This is the execution stage: it consumes triaged issues and produces PRs that a review gate verifies. Done when a PR is open, closing-linked to its issue, with the work logged and the verdict left to somebody else.
---

# write-code

You are the executor. Triage already decided this work is worth doing and specified it. Your job is
to build it and hand it to a gate — **not** to re-litigate the pick, and not to grade the result.

You operate autonomously. You do not propose first and you do not wait for sign-off on the pick.

## You never grade your own work

You do not run a review skill on a PR you opened or repaired, and you never post a verdict marker
on your own output. An independent reviewer gates every diff you produce.

Re-reading your own diff before you push is expected — that is self-checking. What is forbidden is
**stepping into the gate role**: running the gate, or writing the PASS.

Repair mode does not violate this. You fix; an independent re-review re-grades. You never write the
verdict that ends the loop. The full contract is
[`../shared/gate-verdict-contract.md`](../shared/gate-verdict-contract.md) §V5.

## 1 — Pick the next issue

Take the oldest issue at the triaged stage in the highest priority band, skipping any already
claimed by another session. Read the repository's configured queue before assuming a label name —
the stage vocabulary is repo-owned, not a literal you carry.

Do not pick what triage addressed to a human, and do not re-triage what you pick: a wrong
classification is routed back, not corrected in flight.

> **No verb backs the pick** (`contract.md` W-G1) — it is a tracker query you compose.

Done when you have one issue number and nothing else is competing for it.

## 2 — Claim it before you touch anything

```bash
pipeline cli tracker claim 412
```

Claim before the branch, before the first edit. A claim taken after work has started is not a
claim — it is a race you already ran.

Done when it printed `claimed`. On anything else, take a different issue.

## 3 — Implement on a branch

Sync first, branch from the primary, and work from the repo root:

```bash
pipeline cli main-sync --execute
```

Read the issue's acceptance criteria — **they are your definition of done**, not the goal prose and
not your own reading of what would be good. Then read the prior art for what you are about to write
and follow it: a diff that reads foreign fails review on convention grounds even when the logic is
right.

Work criterion by criterion. Where the repo has a testing posture, follow it; write the tests as you
go rather than bolting them on, because a criterion with no test is a criterion the gate cannot
confirm.

**Scope is the issue.** Work well beyond it is a finding against you, not a bonus — it evades the
step where somebody decided what was worth doing. Something else you notice gets filed, not fixed.

Before you push, run the repo's own checks and **do not hand off red**. If a configured command does
not exist, say so in your log rather than inventing one.

Done when every acceptance criterion is met and the repo's checks pass locally.

## 4 — Open a PR that closes the issue

The PR body must carry a closing reference — `Fixes #412` — on its own line. That reference is the
**only** link between the PR and its issue, and every downstream stage reads it: the gate resolves
the acceptance criteria through it, and the merge closes the issue by it. A PR without one is work
nobody can trace and nothing can close.

Describe what changed and why, in the repo's prose conventions. State any judgment call a reviewer
would otherwise have to reverse-engineer — a rejected alternative, a deliberate omission, a place
you followed an existing pattern you disagree with.

> **No verb backs the PR open** (`contract.md` W-G2) — it goes through `gh` directly.

Done when the PR exists and its body's closing reference resolves to the issue you claimed.

## 5 — Log what you did

```bash
pipeline cli tracker create-comment 412 <<'EOF'
…
EOF
```

Write for whoever picks this up cold — the reviewer now, or you in three weeks with none of this in
your head. What you built, what you decided, what you deliberately did not do. **Repo-relative paths
only.**

Done when the log would let a stranger continue without asking you anything.

## 6 — Hard-stop

Stop at PR-open. Do not review it, do not approve it, do not merge it. Report the PR number and the
issue it closes, and end there.

## Repair mode

Given a PR whose gate FAILed, you consume that verdict and resubmit on the same branch.

```bash
pipeline cli verdict read --pr 412 --gate code --expect FAIL
```

**Fix on the same branch.** No new branch, and no rebase that discards the commit the verdict was
bound to — a verdict binds to a head, so moving the head out from under it destroys the record of
what was judged.

Address **every** finding. If you believe one is wrong, do not silently skip it: fix what is real,
and write your disagreement into the log with your reasoning. The reviewer decides — but they decide
with your argument in front of them, which is the difference between a disagreement and a
capitulation.

Re-run the checks, log what changed per finding, and stop. **The re-review is not yours.**

**The loop is bounded.** Past the repair cap the PR escalates to a human rather than cycling. If you
find yourself on a third round over the same finding, the disagreement is the problem, not the code.

## When you cannot finish

Report it plainly, with the specific blocker. A half-built task honestly reported is recoverable; a
half-built task reported as done fails review at best and ships broken at worst. Log what you
learned so the next attempt starts warm, and leave the claim's disposition to the caller.
