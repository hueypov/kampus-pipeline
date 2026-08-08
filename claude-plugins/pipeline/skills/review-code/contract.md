# `review-code` — derived CLI contract

Serves: `skills/review-code/SKILL.md`. Derived 2026-08-07.

**One verb.** `review-code` is the mirror image of `ship-it`: that stage is almost entirely fact, so
nearly all of it became verbs; this one is almost entirely judgment, so almost none of it can.

Whether a criterion is met, whether a finding is real or a hunch, whether a defect traces to the
issue's stated goal — none of those are derivable, and a verb that claimed to decide them would be
a model wearing a CLI's clothes. What *is* mechanical is assembling the inputs, and that is the verb
below.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `review-code brief` | Everything the reviewer needs, in one read | Following the closing reference to the issue, extracting its acceptance criteria, listing changed paths and resolving the head are all lookups. What the reviewer concludes from them is not. |

**Consumed unchanged:** `verdict post` (which already refuses a self-verdict, a malformed marker and
a leaking body), `verdict read`, `review-head` (materializing the diff at the current head),
`report file` (filing an out-of-scope finding).

**Considered and deliberately not derived:**

- *a criteria-checking verb.* Whether a diff satisfies "returns a 400 with the field name when the
  title is empty" is the review. A verb that answered it would be the reviewer.
- *a findings formatter.* The verdict body is prose a human reads during a repair; shaping it is
  writing, and a template would produce findings that look uniform and say less.
- *a severity classifier.* There is no severity tier here by design — a finding is routed in or out
  of scope, and that routing is the trace-to-stated-goal judgment.

---

## `review-code brief`

**Invocation**

```
pipeline cli review-code brief --pr <n> [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request to assemble a brief for |
| `--json` | boolean | no | `false` | emit the brief as one object instead of prose |

**Output**

Prose by default: the head SHA, the linked issue and title, the acceptance criteria as they appear
in the issue body, and the changed paths. Under `--json`, one object with `head`, `issue`,
`criteria` (an array), and `files`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | a brief was assembled, including at least one criterion |
| 7 | the PR carries no closing reference — there is nothing to grade against |
| 4 | the linked issue has no acceptance-criteria section (unchanged: malformed input) |
| 11 | a read failed; the brief is UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `review-code brief: #<n> has no closing reference — nothing to grade against` | stderr | 7 | refusal |
| `review-code brief: #<n> closes #<m>, which has no acceptance criteria` | stderr | 4 | refusal |
| `review-code brief: could not read <what> for #<n> — UNKNOWN` | stderr | 11 | refusal |

Exit 7 and 4 are separate because their owners differ: no closing reference is `write-code`'s defect
(it opens PRs and owns that seam), while an issue with no criteria is `triage`'s — it enriches
issues and owns making "done" legible. Fusing them would send the reviewer to the wrong stage, and
the reviewer is the one party who must not fix either.

**Scope**

The criteria are read from the linked issue's body, from the section the enrichment step writes.
**A criteria section that is present but empty is exit 4, not an empty list.** An empty list would
let a reviewer PASS a PR by satisfying nothing, which is the vacuous-pass shape in a different
place.

**Examples**

```
$ pipeline cli review-code brief --pr 431
head:    30e98f4c69fe9c6b0f5ee2dadc98495f6562506a
closes:  #412 — Reaper leaves worktrees behind after a failed sweep
criteria:
  - [ ] the installed hook resolves the toolkit at run time
  - [ ] a hook that cannot resolve its toolkit fails loudly
  - [ ] a repository initialized before this change is repaired by re-running init
files:
  packages/pipeline-cli/src/tools/ref-guard/command.ts
  packages/pipeline-cli/src/tools/ref-guard/command.unit.test.ts
```

```
$ pipeline cli review-code brief --pr 447
review-code brief: #447 has no closing reference — nothing to grade against
$ echo $?
7
```

**Grounding**

- Assembling this by hand was three reads a reviewer had to remember to make in the right order, and
  the one most often skipped was the head — which is what the verdict binds to.
- Refusing when there is nothing to grade against is the point. A reviewer that invents criteria
  becomes the author of the spec and its judge, which is the same collapse the split-role firewall
  prevents one layer up.

---

## What stays judgment

Everything else, and deliberately:

- whether each acceptance criterion is actually satisfied by the diff
- whether a candidate finding is real — the concrete input and wrong result — or a hunch to drop
- whether a finding traces to the issue's stated goal (in scope) or is real but somebody else's
- the polarity, and what the findings say
- being strict about criteria and tests while sparing about taste
- re-reading rather than posting when the head moved mid-review
