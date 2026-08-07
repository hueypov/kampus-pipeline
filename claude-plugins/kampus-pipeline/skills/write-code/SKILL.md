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

```bash
pipeline cli write-code next
```

Highest priority band first, oldest within it, unclaimed, and addressed to an agent — work triage
sent to a human is excluded by default and is not yours to pick up.

Exit 3 is `empty`: nothing pickable, and you are done. Exit 4 means the read failed, which is not
the same answer — do not report an idle queue on it.

Do not re-triage what you pick. A wrong classification is routed back, not corrected in flight.

Done when you have one issue number.

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

```bash
pipeline cli write-code open-pr --issue 412 --head pipeline/412-reaper \
  --title "Sweep worktrees whose branch was already deleted" <<'EOF'
…
EOF
```

The verb composes the closing reference and verifies after opening that it resolves to the issue you
claimed. You never write `Fixes #N` by hand — that reference is the only link three stages read (the
gate resolves acceptance criteria through it, the merge closes the issue by it, an epic handoff
traces through it), and a PR missing it looks entirely normal until a merge closes nothing.

Your judgment is the description: what changed and why, plus any call a reviewer would otherwise
reverse-engineer — a rejected alternative, a deliberate omission, a pattern you followed and
disagree with.

Exit 5 means the issue is claimed by another session. Do not open the PR anyway.

Done when the verb exits 0 and prints the PR and the issue it closes.

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

Re-run the checks, log what changed per finding, and stop. **The re-review is not yours** — and the
verdict verb will refuse it if you try, because it compares the posting identity against the PR's
author.

**The loop is bounded.** Check before you start:

```bash
pipeline cli write-code rounds --pr 431
```

Exit 3 means at or over the cap: escalate to a human instead of repairing again. A third round over
the same finding means the disagreement is the problem, not the code.

## When you cannot finish

Report it plainly, with the specific blocker. A half-built task honestly reported is recoverable; a
half-built task reported as done fails review at best and ships broken at worst. Log what you
learned so the next attempt starts warm, and leave the claim's disposition to the caller.
