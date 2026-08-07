# write-code — contract

What the `write-code` skill must do, stated so it can be checked. `evals/evals.json` is the
executable form.

## Purpose and boundary

`write-code` is the execution stage. It consumes one triaged issue and produces a pull request that
closes it, then stops.

It **does not** triage, plan, review, approve, or merge. The one it is most tempted to do is review,
because it has just read the diff more closely than anyone — and that is exactly why it must not.

## Invocation axis

**Model-invoked.** An orchestrator dispatches it and an agent reaches for it on "work the next
issue". It keeps its description.

## Invariants

**W1 — Never grade your own work.** No review skill run on a PR you opened or repaired, and no
verdict marker on your own output, ever. Re-reading your diff before pushing is self-checking;
running the gate is stepping into a role that exists to be independent of you. See
[`../shared/gate-verdict-contract.md`](../shared/gate-verdict-contract.md) §V5.

**W2 — Claim before the first edit**, not before the push and not after the branch. A claim taken
once work is underway does not prevent the collision it exists to prevent; it just records who lost.

**W3 — The acceptance criteria are the definition of done.** Not the goal prose, not the title, and
not the run's own reading of what would be good. A criterion with no test is a criterion the gate
cannot confirm.

**W4 — Scope is the issue.** Work beyond it is a defect, not a bonus: it bypasses the stage where
somebody decided what was worth doing, and it enlarges a diff a reviewer agreed to read at one size.
Something else noticed is filed, not fixed.

**W5 — Match the surrounding code.** Convention drift fails a gate on its own, independent of
whether the logic is right.

**W6 — Never hand off red.** The repo's own checks pass locally before the PR opens. A configured
command that does not exist is reported, never invented.

**W7 — The PR carries a closing reference to its issue.** `Fixes #N` on its own line. This is the
*only* link between a PR and its issue, and three downstream stages read it: the gate resolves
acceptance criteria through it, the merge closes the issue by it, and any epic handoff traces
through it. A PR without one is work nothing can close and nobody can trace.

**W8 — The log lets a stranger continue.** What was built, what was decided, what was deliberately
not done — written for the reviewer now and for whoever returns in three weeks. Repo-relative paths
only.

**W9 — Hard-stop at PR-open.** Report the PR and the issue it closes. Do not review, approve, or
merge.

**W10 — Repair fixes on the same branch.** No new branch, and no rebase that discards the commit the
verdict bound to. A verdict binds to a head; moving the head out from under it destroys the record
of what was judged and silently converts a FAIL into an unreviewed state.

**W11 — Every finding is addressed or argued, never silently skipped.** A finding believed wrong is
answered in the log with reasoning, and the reviewer decides with that argument in front of them.
Silently skipping one produces a second FAIL for the same cause and burns a bounded round.

**W12 — The repair loop is bounded.** Past the cap the PR escalates to a human rather than cycling.
Two agents can disagree indefinitely; nothing in the loop converges on its own.

**W13 — An unfinished task is reported unfinished**, with the specific blocker. A half-built task
reported as done fails review at best and ships broken at worst.

## Verb surface it depends on

| Verb | Role |
|---|---|
| `pipeline cli tracker claim <n>` | Marker-based claim; `claimed` means this session holds it |
| `pipeline cli claim is-mine --issue <n>` | Default-deny ownership re-check before a later mutation |
| `pipeline cli main-sync --execute` | Fast-forward the primary checkout; never resets or force-checks-out |
| `pipeline cli tracker create-comment <n>` | The progress log; body on stdin |
| `pipeline cli verdict read --pr <n> --gate <g> --expect FAIL` | Repair mode's input — the current-head FAIL and its findings |

## Known gaps in the deterministic layer

**W-G1 — The pick has no verb.** Selecting the next triaged, unclaimed issue in priority order is a
composed query the agent writes. It is deterministic in full — an ordering over a filtered set — so
it is a verb waiting to be written, and until it is, every run may pick differently.

**W-G2 — The PR open has no verb, so W7 is unguarded.** The closing reference is the single link
three stages depend on, and nothing checks it exists, resolves, or points at the claimed issue. A PR
opened without it looks completely normal and fails silently much later, at a merge that closes
nothing.

**W-G3 — Nothing enforces W1.** The split-role firewall is prose in this skill and prose in the
reviewer's. Two skills agreeing not to cross a line is not a boundary. The structural enforcement
lives outside the skills — in who is dispatched — and there is no check that the dispatcher got it
right.

**W-G4 — The repair cap is not counted anywhere.** W12 names a bound with no counter behind it.
Round count lives in whatever orchestrates the loop, so a skill invoked directly can repair
indefinitely without ever reaching an escalation.

**W-G5 — No scratchpad verb.** Any intermediate file this skill writes falls back to the inline
recipe in `../../agents/STANDING-INVARIANTS.md` §SP rather than a fail-closed verb.

## Out of scope

Triaging, planning, reviewing, approving, merging, and deciding whether the pick was worth doing.
