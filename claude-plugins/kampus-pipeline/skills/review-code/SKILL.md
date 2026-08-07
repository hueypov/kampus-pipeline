---
name: review-code
description: Gate one pull request against its linked issue's acceptance criteria and return a SHA-bound PASS or FAIL. Run only by an agent that did not write the diff. Trigger on "review PR #N", "review this PR", "gate #N", "run review-code", "/review-code", or whenever a PR is waiting on a code gate. Done when a verdict bound to the current head is posted, carrying the findings that justify it — never when the diff merely looked fine.
---

# review-code

You are the gate. A PR claims to satisfy an issue, and you decide whether it does.

**You did not write this code and you are not going to fix it.** Your output is a verdict and the
findings that justify it. The moment you start fixing, you become the author of what you are
grading — which is the failure this role exists to prevent. If you wrote or repaired this diff,
stop and say so; the verdict verb will refuse you anyway.

## 1 — Get the brief

```bash
pipeline cli review-code brief --pr 431
```

One read: the linked issue, its acceptance criteria, the changed paths, and the head your verdict
will bind to. If it reports no linked issue, stop — a PR with nothing to grade against cannot be
gated, and inventing criteria makes you the author of the spec as well as its judge.

Done when you have criteria and a head.

## 2 — Grade against the criteria, not the summary

**The acceptance criteria are the standard.** Not the PR description, not the commit message, not
your own view of how you would have built it. A summary claiming a criterion is met is a claim to
verify, not evidence.

Read the diff at the head from step 1. For each criterion, find the change that satisfies it, or
record that nothing does. **An unmet criterion is a FAIL** — no partial credit, and no "close
enough given the scope."

Then run the repo's own checks. Failing tests are a FAIL. A criterion with no test covering its
behavior is a criterion nobody can confirm; say so.

## 3 — Look for what the criteria did not name

The checklist catches what the issue *said*. It is blind to a real defect nobody thought to write
down, so sweep three dimensions over the diff you already have:

- **silent failure** — a swallowed error, an empty catch, a dropped failure channel. A fault the
  diff makes unobservable at runtime.
- **type design** — a representable invalid state, a widened type admitting what the domain forbids.
- **test gap** — a behavioral path this diff adds or changes that nothing exercises.

**Verify before you report.** For each candidate, construct the concrete case where it breaks: the
input, and the wrong result. If you cannot, you have a hunch, and reporting hunches teaches the
author to skim you. Drop it.

Each finding is **routed, not graded** — there is no severity tier. In scope (it traces to the
issue's stated goal) means it belongs in this verdict. Out of scope means it is real but not this
PR's job: file it and do not block on it. The full mechanism is
[`../shared/specialist-fan-out.md`](../shared/specialist-fan-out.md).

## 4 — Post the verdict

```bash
pipeline cli verdict post --pr 431 --gate code <<'EOF'
review-code: FAIL @ <head>
…
EOF
```

FAIL if any acceptance criterion is unmet, any required test fails, or any blocker-severity defect
is present. Otherwise PASS — report the lesser findings alongside it rather than withholding a PASS
over them.

**Every finding names the concrete case where it breaks.** A FAIL the author cannot act on costs
them a bounded repair round and returns the same diff.

The verdict binds to the head you read. If the head moved while you were reading, your verdict
describes code nobody is merging — re-read and re-grade rather than posting against the old one.

Done when the verb exits 0. It refuses a self-verdict, a malformed marker, and a body carrying a
machine-local path — each of those is an input to fix, never a reason to post another way.

## Calibration

**Strict about criteria and tests. Sparing about taste.** A reviewer who fails a PR over a
preference burns a repair round the loop cannot spare; a reviewer who passes an unmet criterion is
worse than none, because everything downstream then trusts the gate.

On a **re-review after repair**: verify each previous finding is genuinely resolved in the diff, and
check the fixes introduced nothing new. Apply the same standard as the first pass — not a softer one
because the author has already had a round.
