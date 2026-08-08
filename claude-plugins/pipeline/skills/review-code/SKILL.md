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

## The discipline — run, don't read

Nothing below is inferred from reading when it can be executed. The day this section was earned,
one author made nine false claims in one session — counts, quotes, "all references repointed" —
and every one fell to a reviewer who ran the command instead of trusting the sentence.

- **The PR body is a claim under review, not context.** Re-derive every number and every "nothing
  remains" it asserts. Where your derivation disagrees, your derivation is the finding — including
  when the diff the API serves is not the diff the body describes.
- **A new test must not pass against the parent commit.** Check out the parent, overlay the PR's
  test files, run them. A new case that PASSES there pins nothing — a test asserting the absence of
  a call that never existed stays green over the very bug it was written for. A file that fails to
  load because it imports the PR's own symbols counts as failing, not passing — but a load failure
  proves little: where the new cases can run against the parent at all, they must fail by
  asserting, and the verdict says which kind of failure it observed.
- **A suite count that did not move did not run.** Compare the head's suite total against the
  parent's — from a run at the parent commit, or the base branch's latest CI. A body claiming six
  new tests above an unmoved total is describing tests that are not in the commit.
- **Attack both failure directions.** A guard that refuses legitimate work breaks the pipeline as
  surely as one that passes defects. The sweep's corpus is the repository itself — the invocations
  its skills, workflows, and tests already make of the changed surface — and one refusal of a
  legitimate input blocks. When the PR claims to fix a defect, also reproduce that defect against
  the parent, so the fix is shown to fix something.
- **Consume every probe whole.** Never pipe a gate-relevant read through `tail`, `head`, or a
  count: a filtered probe reports the one line habit expected and discards the lines that mattered,
  and no surprise ever triggers a re-check. Record the probe's complete output where the verdict
  cites it. When a result does surprise you, verify the probe before believing what it says about
  the code — a broken sweep loop reports failures that do not exist.

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

FAIL if any acceptance criterion is unmet, any required test fails, or any verified in-scope defect
is present. Otherwise PASS — report the lesser findings alongside it rather than withholding a PASS
over them.

**Every finding names the concrete case where it breaks.** A FAIL the author cannot act on costs
them a bounded repair round and returns the same diff.

The verdict binds to the head you read. If the head moved while you were reading, your verdict
describes code nobody is merging — re-read and re-grade rather than posting against the old one.

Two checks before the post, both executed:

- `gh api user --jq .login` — you post as the identity you **are**, and it must not be the PR's
  author. `--as` is an assertion the verb compares against the author; it cannot tell who is
  actually authenticated, so an unchecked identity posts a void verdict under the wrong name.
- `pipeline cli class-probe classify --namespaces` with the changed paths on stdin and `--root`
  pointing at a checkout that carries `.pipeline/agent-policy.json` — review worktrees do not: the
  policy is untracked, and without it the classifier fail-closes to EVERY namespace. That four-line
  answer is a dispatch notice, not a classification; its status line lands on stderr, so read both
  streams and treat `policy trusted from <path>` as part of the answer. The stdout lines, whole,
  are the `--gate` values your verdicts must cover. No readable policy anywhere → stop and report,
  exactly as with a missing linked issue: a verdict you cannot ground in a classification
  fabricates the gate it posts in. A namespace with its own working gate skill is reviewed under
  that checklist — where none is usable yet, apply this skill's discipline and say so in the
  verdict. Sixteen of this repository's first twenty-two merges shipped with a required namespace
  unverdicted, four with no verdict at all (#60); this check is what ends that.

Done when every required namespace carries your verdict and each post exited 0. The verb refuses a
self-verdict, a malformed marker, and a body carrying a machine-local path — each of those is an
input to fix, never a reason to post another way.

## Calibration

**Strict about criteria and tests. Sparing about taste.** A reviewer who fails a PR over a
preference burns a repair round the loop cannot spare; a reviewer who passes an unmet criterion is
worse than none, because everything downstream then trusts the gate.

On a **re-review after repair**: verify each previous finding is genuinely resolved in the diff, and
check the fixes introduced nothing new. Apply the same standard as the first pass — not a softer one
because the author has already had a round.
