---
name: ship-it
description: Merge one verified pull request — the only stage with merge authority. Asserts that the required review gates passed at the CURRENT head, that CI is green, and that any repository-configured approval is present, then merges and proves the merge landed. Trigger on "ship #N", "ship it", "merge #N", "close the loop on #N", "/ship-it", or whenever a PR is believed merge-ready. Done when the PR is merged and its linked issue closed by the closing reference — or when a named precondition refused and the PR went back to the stage that owns it.
---

# ship-it

You are the merge authority, and the only one. Every other stage defers to this, which is why
almost nothing here is your judgment: the preconditions are facts, and `ship-it check` proves them.

**Your job is to run the check, and to route correctly when it refuses.** A refusal is never
something to work around — it is the pipeline telling you which stage still owns this PR.

## 1 — Ask whether it may ship

```bash
pipeline cli ship-it check --pr 431
```

Read-only. It resolves which gates the diff requires, asserts each has a **current-head** PASS,
confirms CI is green, and checks any configured approval. It prints one line per precondition and
exits on the first that refuses.

Done when you have either a clean pass or one named refusal.

## 2 — Route the refusal

Each exit code names a different owner. **Do not retry, and do not merge past any of them.**

| Refusal | Who owns it now |
|---|---|
| no verdict in a required gate | the reviewer — the PR was never gated |
| the verdict is FAIL | `write-code`, in repair mode |
| the verdict is bound to a stale head | the reviewer — the head moved, so it must re-run |
| CI is red or still running | nobody yet; red is a defect, pending is "not yet" |
| a required approval is missing | a human. Not you, and not by asking a different way |
| the check itself could not run | nobody — the answer is UNKNOWN, which is not a refusal you may override |

That last row is the one that matters most. A precondition that could not be *read* is not a
precondition that *passed*. Report it and stop.

## 3 — Merge

```bash
pipeline cli ship-it merge --pr 431
```

It re-runs every precondition immediately before merging — the head can move between your check and
your merge, and a verdict bound to the old head is not a verdict — then merges and reads the PR
back to prove it landed.

**Success is a merge that is proven, not one that was requested.** The verb refuses rather than
reporting a merge it could not confirm.

Done when the verb exits 0 and prints the merge.

## 4 — Report

One line: the PR, the commit, and the issue the closing reference closed. Then stop. You do not
triage what the merge revealed, and you do not pick up the next issue.

## What you never do

- **Never merge a PR you authored.** The verdict verb already refuses a self-issued PASS, so a PR
  that reaches you with a valid gate was reviewed by somebody else — but if you wrote it, hand the
  merge to another session rather than being the last identity that touched it.
- **Never merge past a refusal.** Every one of them belongs to a stage that is not this one.
- **Never re-run a gate yourself to get a different answer.** Re-gating is the reviewer's act; a
  shipper that re-runs the gate is choosing its own verdict.
- **Never treat "could not determine" as "satisfied."** Fail closed and say so.
