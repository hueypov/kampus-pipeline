# `write-code` — derived CLI contract

Serves: `skills/write-code/SKILL.md`. Derived 2026-08-07.

The verbs `write-code` needs, fully specified. A fresh implementing agent builds every one from this
document alone.

Three verbs and one amendment. The amendment matters most: the split-role firewall — the rule that
an author never grades their own work — is today enforced by prose in two skills agreeing not to
cross a line, which is not a boundary. §Firewall makes it one.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `write-code next` | Which issue to pick up | Filtering by stage, audience and claim state, then ordering by priority and age, is a total function over the queue. Whether the pick is worth doing was already decided by triage. |
| `write-code open-pr` | Open a PR that provably closes its issue | Composing the closing reference, verifying it resolves to the claimed issue, and reading the PR back are mechanical. The description is judgment. |
| `write-code rounds` | How many repair rounds this PR has had | Counting verdicts in a namespace against a configured cap is arithmetic. What to do at the cap is judgment. |
| *(amendment)* `verdict post` | Refuse a verdict from the PR's own author | Comparing the posting identity against the PR's authoring identity is a string comparison. |

**Consumed unchanged**, already implemented and needing no derivation: `tracker claim` (the durable
hold on an issue), `tracker create-comment` (the progress log), `verdict read` (repair mode's input),
and `main-sync` (fast-forward the primary checkout). They are listed so this spec states the skill's
whole dependency surface, not only the part being built.

---

## `write-code next`

**Invocation**

```
pipeline cli write-code next [--stage <name>] [--ready-for <who>] [--limit <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--stage` | string | no | the repository's configured triaged stage | the lifecycle stage to pick from |
| `--ready-for` | string | no | `agent` | the audience to pick: `agent`, `human`, or `any` |
| `--limit` | integer | no | `1` | how many candidates to print, best first |

**Output**

Machine-readable. First stdout line is the outcome: `pick` or `empty`. On `pick`, one
`#<number>\t<priority>\t<title>` line per candidate, best first.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | `pick` — at least one candidate |
| 3 | `empty` — the stage was read and holds nothing pickable |
| 4 | the read failed; pickability is UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `write-code next: could not read stage '<name>' (<reason>) — UNKNOWN` | stderr | 4 | refusal |
| `write-code next: --ready-for must be agent, human, or any` | stderr | 1 | usage |

**Scope**

Candidates are issues at the stage, addressed to `--ready-for`, **and unclaimed**. Ordering is
highest priority band first, oldest first within a band. An issue held by another session is
excluded, not ranked lower — a claim is a boundary, not a preference.

`--ready-for human` exists for a person listing their own queue. The default excludes it, so work
written for a human never surfaces to a builder.

**Examples**

```
$ pipeline cli write-code next
pick
#412	p1	Reaper leaves worktrees behind after a failed sweep
```

```
$ pipeline cli write-code next --ready-for agent
empty
$ echo $?
3
```

**Grounding**

- Today the pick is a query each run composes, so two runs can pick differently from the same queue
  and neither is wrong. A total function over the queue makes the order reviewable.
- Exit 3 separates "nothing to do" from "could not tell", so an orchestrator does not treat a failed
  read as an idle queue and stop.

---

## `write-code open-pr`

**Invocation**

```
pipeline cli write-code open-pr --issue <n> --head <branch> --title <text> [--draft] [--dry-run]
```

The PR description arrives on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the issue this PR closes; the closing reference is composed from it |
| `--head` | string | yes | — | the branch carrying the work |
| `--title` | string | yes | — | the PR title |
| `--draft` | boolean | no | `false` | open as a draft |
| `--dry-run` | boolean | no | `false` | run the guards and print the composed body; open nothing |

**Output**

Prose, one line: `write-code: opened #<pr> — closes #<issue> — <url>`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the PR opened and its closing reference read back resolving to `--issue` |
| 2 | a guard refused before any write |
| 4 | opened, but the closing reference did not read back |
| 5 | `--issue` is not claimed by this session |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `write-code open-pr: empty description on stdin` | stderr | 2 | refusal |
| `write-code open-pr: machine-local path in description (<class>)` | stderr | 2 | refusal |
| `write-code open-pr: #<n> is claimed by session <id>, not this one` | stderr | 5 | refusal |
| `write-code open-pr: branch '<head>' has no commits ahead of base` | stderr | 2 | refusal |
| `write-code open-pr: opened #<pr> but its closing reference does not resolve to #<n>` | stderr | 4 | refusal |

**Scope**

The verb **composes the closing reference itself** and verifies after opening that the PR resolves
to `--issue`. A caller never writes `Fixes #N` by hand.

That reference is the only link three stages read: the gate resolves acceptance criteria through it,
the merge closes the issue by it, and an epic handoff traces through it. A PR missing it looks
entirely normal and fails silently much later, at a merge that closes nothing — which is why the
verification is unconditional rather than a flag.

**Examples**

```
$ pipeline cli write-code open-pr --issue 412 --head pipeline/412-reaper \
    --title "Sweep worktrees whose branch was already deleted" <<'EOF'
The reaper skipped a worktree when its branch was gone…
EOF
write-code: opened #431 — closes #412 — https://github.com/hueypov/kampus-pipeline/pull/431
```

**Grounding**

- Exit 5 exists because opening a PR against an issue held by another session is how two builders
  land competing PRs for one ticket; the claim check belongs at the write, not only at the pick.

---

## `write-code rounds`

**Invocation**

```
pipeline cli write-code rounds --pr <n> [--gate <g>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request whose repair rounds to count |
| `--gate` | string | no | all gates | restrict the count to one gate namespace |

**Output**

Machine-readable, one line: `rounds <k> cap <n> <under|at|over>`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | under the cap — another repair round is permitted |
| 3 | at or over the cap — escalate to a human, do not repair again |
| 4 | the verdict history could not be read; round count UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `write-code rounds: could not read verdict history for #<n> — count UNKNOWN` | stderr | 4 | refusal |

**Scope**

A round is one FAIL verdict in a gate namespace. The cap comes from repository policy; absent
policy, the default cap is 2. Exit 3 is the escalation signal, and it is the verb's job rather than
the skill's because a bound nobody counts is not a bound — a directly-invoked run with no
orchestrator can otherwise repair forever.

**Examples**

```
$ pipeline cli write-code rounds --pr 431
rounds 1 cap 2 under
$ pipeline cli write-code rounds --pr 447
rounds 2 cap 2 at
$ echo $?
3
```

**Grounding**

- The cap is named in the skill with no counter behind it, so it holds only when something outside
  the skill happens to be counting.

---

<a id="firewall"></a>
## Amendment to `verdict post` — the firewall becomes structural

`verdict post` **must refuse a verdict whose posting identity authored the pull request.**

**Added inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--as` | string | no | `$CLAUDE_CODE_SESSION_ID` | the reviewing identity, compared against the PR's authoring identity |

**Added exit status**

| Code | Trigger |
|---|---|
| 7 | the posting identity authored this PR — a self-verdict, refused |

**Added error**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `verdict post: #<pr> was authored by this identity — an author may not post a verdict on their own work` | stderr | 7 | refusal |

**Scope**

Identity is the authoring session recorded by `write-code open-pr`, falling back to the PR's author
account when no session was recorded. When neither can be resolved, the verb **refuses** rather than
allowing: an unresolvable identity is exactly the state a caller trying to grade its own work would
produce.

This does not block repair. An author may fix a FAIL; what they may not do is write the verdict that
ends the loop.

**Grounding**

- Today the firewall is prose in `write-code` and prose in the reviewer skills. Two documents
  agreeing not to cross a line is a convention; a refusal at the write is a boundary.
- The real enforcement was always meant to live in *who gets dispatched*, and nothing checks the
  dispatcher got it right. This closes that without depending on the orchestrator.

---

## What stays judgment

- whether an acceptance criterion is actually met, and whether a test covers it
- whether a finding is real, or a hunch that will waste a bounded round
- what the PR description must say that the diff does not
- whether an adjacent defect is in scope (it is not) or worth filing (it is)
- what to do at the cap — the verb says stop repairing; the human decides what happens next
- reporting a task unfinished, which no verb can detect
