# `triage` — derived CLI contract

Serves: `skills/triage/SKILL.md`. Derived 2026-08-07.

The verbs `triage` needs, fully specified. A fresh implementing agent builds every one from this
document alone.

Four of these do not exist in any form today, and their absence is why the skill's first draft
silently dropped four steps: provenance was read by grepping a body, parking and killing had no
path, and enrichment — the largest step in the skill — went through a raw API call with nothing
checking that the original survived it.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `triage queue` | What is waiting to be triaged | Listing a stage and reporting whether the read succeeded is mechanical. Which issue to take first is judgment. |
| `triage claim` | Take a sweep-scoped hold on one issue | Posting an authorized session-stamped marker and resolving the earliest one is mechanical. |
| `triage release` | Drop the hold when the outcome lands | Removing this session's own marker is mechanical, and forgetting to is not a decision anyone makes. |
| `triage provenance` | Was this filed by a human or an agent | Detecting the footer marker is a string predicate. Whether an ambiguous case is treated as human is judgment, and the verb reports ambiguity rather than resolving it. |
| `triage split` | File one child of a bundle, exactly once | The create-once key, the back-reference, and the duplicate check are mechanical. What the units *are* is judgment. |
| `triage enrich` | Replace the body, preserving the original | Composing the preserve block, redacting a leak inside it, and refusing a rewrite that lost the original are mechanical. The rewrite's content is judgment. |
| `triage apply` | Stamp the classification and leave the queue | Applying labels, dropping the queue label, honouring the homing policy, and reading back the result are mechanical. The classification is judgment, supplied as parameters. |
| `triage park` | Leave the queue awaiting a human's answer | Moving the stage and attaching questions is mechanical; refusing to close is a fixed rule, not a call. |
| `triage kill` | Close an agent filing, folding content first | The fold-then-close ordering and the audit marker are mechanical. Whether salvage failed is judgment, attested by a flag. |

---

## `triage queue`

**Invocation**

```
pipeline cli triage queue [--stage <name>] [--limit <n>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--stage` | string | no | the repository's configured intake stage | the lifecycle stage to list |
| `--limit` | integer | no | `50` | maximum issues to print |

**Output**

Machine-readable. First stdout line is the outcome: `queue` or `empty`. On `queue`, one
`#<number>\t<claim-state>\t<title>` line per issue, oldest first, where claim-state is `free` or
`held`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the read succeeded — `queue` or `empty` |
| 4 | the read failed; the queue contents are UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage queue: could not read stage '<name>' (<reason>) — contents UNKNOWN` | stderr | 4 | refusal |
| `triage queue: --limit must be a positive integer` | stderr | 1 | usage |

**Scope**

One stage. `empty` means the stage was read and holds nothing; it is the only result that ends a
sweep. A failed read is exit 4 and never prints `empty`.

**Examples**

```
$ pipeline cli triage queue
queue
#4312	free	Editor loses focus after save
#4318	held	Two things — pagination and the config loader
```

**Grounding**

- A sweep that treats a failed read as an empty queue reports "nothing left to triage" while the
  backlog is untouched.

---

## `triage claim` / `triage release`

**Invocation**

```
pipeline cli triage claim <target> [--session <id>]
pipeline cli triage release <target> [--session <id>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the issue number to claim or release |
| `--session` | string | no | `$CLAUDE_CODE_SESSION_ID` | the session id to claim as; the delegated token on an orchestrated path |

**Output**

Prose, one line: `triage: claimed #<n> (session <id>) — proceed.` /
`triage: released #<n>.` / `triage: #<n> held by session <id> since <ts> — back off.`

**Exit status**

| Code | Trigger |
|---|---|
| 0 | `claim`: the hold is ours. `release`: the hold is gone (including when we did not hold one) |
| 3 | `claim`: another session holds it, or we lost the tiebreak — back off, do not mutate |
| 2 | no session id available, so no distinguishable claim can be made |
| 4 | the read or write failed; ownership is UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage claim: no session id (set $CLAUDE_CODE_SESSION_ID or pass --session) — refusing an indistinguishable claim` | stderr | 2 | refusal |
| `triage claim: #<n> is held by session <id> — back off, do not mutate` | stderr | 3 | refusal |
| `triage release: could not confirm the hold was removed on #<n>` | stderr | 4 | refusal |

`release` is idempotent: releasing a hold we do not have is exit 0, because the goal — no hold — is
already met.

**Scope**

A triage hold is **sweep-scoped**, unlike the durable hold `write-code` takes. It exists to stop two
concurrent sweeps rewriting one body, and it must not outlive the sweep: an issue whose triage hold
was never released can never be re-triaged, because every later session backs off at exit 3.

**Examples**

```
$ pipeline cli triage claim 4312
triage: claimed #4312 (session a0bd6818) — proceed.
$ pipeline cli triage release 4312
triage: released #4312.
```

**Grounding**

- `tracker claim` exists; there is no counterpart that drops a hold, so today a triaged issue keeps
  its claim marker permanently.
- Exit 3 is separate from 1 so "somebody else has it" — an expected, correct outcome during a
  concurrent sweep — is never confused with a broken invocation.

---

## `triage provenance`

**Invocation**

```
pipeline cli triage provenance <target>
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the issue whose filing provenance to resolve |

**Output**

Machine-readable, one word on stdout: `agent`, `human`, or `ambiguous`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | `agent` — the provenance footer is present and well-formed |
| 3 | `human` — no footer; hand-typed, and therefore protected from closure |
| 5 | `ambiguous` — a footer-like line that does not parse; treat as human |
| 4 | the body could not be read; provenance UNKNOWN |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage provenance: #<n> body unreadable (<reason>) — provenance UNKNOWN` | stderr | 4 | refusal |

**Scope**

The body's footer only. **Authorship is deliberately not consulted**: every filing carries the same
author when agents run under one token, so authorship answers a different question than the one
asked. A malformed footer resolves to `ambiguous`, never to `agent` — the failure must fall toward
protection.

**Examples**

```
$ pipeline cli triage provenance 4312
agent
$ pipeline cli triage provenance 4403
human
$ echo $?
3
```

**Grounding**

- This is the only check standing between a person's issue and machine closure, and it is currently
  performed by an agent looking for a string in a body.
- `human` is exit 3 rather than 0 so a caller that ignores the exit code and reads only stdout still
  cannot proceed to a close by accident.

---

## `triage split`

**Invocation**

```
pipeline cli triage split <parent> --title <text> [--dry-run]
```

Child body on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<parent>` | integer | yes | — | the bundled issue this child is split from |
| `--title` | string | yes | — | the child's single-unit title |
| `--dry-run` | boolean | no | `false` | run the guards and print the composed child; create nothing |

**Output**

Prose, one line: `triage: split #<parent> -> created #<child> — <url>`, or
`triage: split #<parent> -> #<child> already covers this unit — reused.`

**Exit status**

| Code | Trigger |
|---|---|
| 0 | a child was created, or an existing one covering this (parent, title) was found and reused |
| 2 | a guard refused before any write |
| 4 | created, but the read-back did not match |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage split: empty body on stdin — nothing to file` | stderr | 2 | refusal |
| `triage split: machine-local path in body (<class>)` | stderr | 2 | refusal |
| `triage split: #<parent> not found` | stderr | 2 | refusal |

**Scope**

The verb composes the `split from #<parent>` back-reference itself and keys the create-once check on
`(parent, title)` rather than on body equality, so a retry that re-emits a slightly reworded body is
still recognised as the same unit. The child enters at the intake stage carrying no classification.

**Examples**

```
$ pipeline cli triage split 4404 --title "Queue listing paginates wrong past 30 items" <<'EOF'
The listing drops entries after the first page.
EOF
triage: split #4404 -> created #4409 — https://github.com/hueypov/kampus-pipeline/issues/4409
```

**Grounding**

- A caller composing the back-reference by hand is how a retry files a byte-identical twin: the key
  is only load-bearing if the thing that reads it also wrote it.

---

## `triage enrich`

**Invocation**

```
pipeline cli triage enrich <target> [--epic] [--redact] [--dry-run]
```

The rewrite arrives on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the issue whose body to replace |
| `--epic` | boolean | no | `false` | wrap the original in place under an epic header instead of writing a rewrite above it |
| `--redact` | boolean | no | `false` | mask machine-local paths found in the preserved original rather than refusing |
| `--dry-run` | boolean | no | `false` | compose and print the resulting body; write nothing |

**Output**

Prose, one line: `triage: enriched #<n> — original preserved (<bytes> bytes).` Under `--dry-run`,
the composed body on stdout.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the body was replaced and read back with the original intact |
| 2 | a guard refused before any write |
| 4 | written, but the read-back shows the original did not survive |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage enrich: empty rewrite on stdin — refusing to replace a body with nothing` | stderr | 2 | refusal |
| `triage enrich: machine-local path in the rewrite (<class>)` | stderr | 2 | refusal |
| `triage enrich: machine-local path in the original (<class>) — pass --redact to preserve it masked` | stderr | 2 | refusal |
| `triage enrich: --epic given but stdin is not empty — an epic's brief is never rewritten over` | stderr | 2 | refusal |
| `triage enrich: read-back on #<n> shows the original was not preserved` | stderr | 4 | refusal |
| `triage enrich: #<n> already carries a preserve block — re-enriching would nest it` | stderr | 2 | refusal |

**Scope**

The verb owns the preserve block end to end: it fetches the current body, scans it for leaks,
redacts under `--redact`, wraps it in `<details>` titled `Original report (verbatim)` — or
`Original brief (verbatim)` under `--epic` — and appends it beneath the rewrite. Under `--epic` no
rewrite is accepted at all: the brief is collapsed in place beneath a one-line header and nothing is
written above it.

Re-enrichment is refused rather than nested, because a body with two preserve blocks has no single
original and the next reader cannot tell which is authoritative.

**Examples**

```
$ pipeline cli triage enrich 4402 --redact <<'EOF'
## Problem
The scratch helper writes state outside the repo.

## Acceptance criteria
- [ ] state lands under the repo
EOF
triage: enriched #4402 — original preserved (147 bytes).
```

**Grounding**

- This is the largest step in the skill and today has no verb at all: the body edit goes through a
  raw API call, so nothing checks the original survived, that paths stayed repo-relative, or that a
  second enrichment did not nest a preserve block inside another.
- The `--epic` refusal-on-stdin encodes that an epic's brief is a planner's input: a rewrite above
  it forks the thing the planner reads.

---

## `triage apply`

**Invocation**

```
pipeline cli triage apply <target> --type <t> --priority <p> [--ready-for <who>]
                          [--home <milestone>|--lane <label>] [--stage <name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the issue to stamp |
| `--type` | string | yes | — | the classification: one of the repository's configured types |
| `--priority` | string | yes | — | the priority band |
| `--ready-for` | string | no | `agent` | who the work is addressed to: `agent` or `human` |
| `--home` | string | no | none | the milestone to home it in |
| `--lane` | string | no | none | a standing-lane label, instead of a milestone |
| `--stage` | string | no | the configured triaged stage | the lifecycle stage to move to |

**Output**

Prose, one line reading back what landed:
`triage: #<n> — type:<t> <p> ready-for:<who> stage:<s> home:<h|lane|none>`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | every facet landed and read back as sent |
| 2 | a guard refused before any write |
| 4 | written, but the read-back differs from what was sent |
| 6 | homing is required by policy and neither `--home` nor `--lane` was given |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage apply: --home and --lane are mutually exclusive` | stderr | 1 | usage |
| `triage apply: '<t>' is not a configured type` | stderr | 2 | refusal |
| `triage apply: homing is required by policy — pass --home or --lane` | stderr | 6 | refusal |
| `triage apply: milestone '<h>' does not exist — triage never creates one` | stderr | 2 | refusal |
| `triage apply: read-back on #<n> differs from what was sent` | stderr | 4 | refusal |

**Scope**

**Homing is policy-driven.** The verb reads `github.triage.homing` from the repository's agent
policy: when absent or disabled, `--home` and `--lane` are optional and exit 6 never fires; when
enabled, exactly one is required and its `lanes` list is the only accepted `--lane` vocabulary. A
repository with no milestones and no declared lanes is a valid configuration, not a broken one.

The verb never creates a milestone. Curating them is a human act, and a verb that could mint one
would let a sweep invent structure nobody agreed to.

**Examples**

```
$ pipeline cli triage apply 4312 --type bug --priority p2
triage: #4312 — type:bug p2 ready-for:agent stage:triaged home:none
```

```
$ pipeline cli triage apply 4318 --type decision --priority p1 --ready-for human
triage: #4318 — type:decision p1 ready-for:human stage:triaged home:none
```

**Grounding**

- `--ready-for` separates two questions that today collapse into one: `stage:triaged` says the
  ticket is ready, and nothing says ready *for whom*. Without it, a decision written for a person
  lands in a builder's candidate pool.
- Exit 6 is distinct so a policy-required home that is missing cannot be mistaken for a rejected
  classification.

---

## `triage park`

**Invocation**

```
pipeline cli triage park <target> [--stage <name>]
```

The questions arrive on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the human-filed issue to park |
| `--stage` | string | no | the configured needs-info stage | the lifecycle stage to move to |

**Output**

Prose, one line: `triage: parked #<n> at <stage> — questions posted.`

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the questions landed and the stage moved |
| 2 | a guard refused before any write |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage park: empty body on stdin — parking without questions strands the issue` | stderr | 2 | refusal |
| `triage park: machine-local path in body (<class>)` | stderr | 2 | refusal |

**Scope**

Park **never closes**, and there is no flag that makes it. It removes the issue from the intake
queue so a parked question stops resurfacing in every sweep, and it posts the questions that would
unblock triage. Whoever answers moves the stage back.

Parking with no questions is refused: an issue parked in silence is one nobody knows how to
progress, which is worse than leaving it in the queue.

**Examples**

```
$ pipeline cli triage park 4403 <<'EOF'
Which command produced this, and what did you expect instead of what you saw?
EOF
triage: parked #4403 at needs-info — questions posted.
```

**Grounding**

- The empty-body refusal encodes the failure mode this verb exists to prevent: a queue drained by
  parking everything unactionable, with no path back.

---

## `triage kill`

**Invocation**

```
pipeline cli triage kill <target> --confirm [--duplicate-of <n>]
```

The reason arrives on **stdin**.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<target>` | integer | yes | — | the agent-filed issue to close not-planned |
| `--confirm` | boolean | yes | — | your attestation that salvage was genuinely attempted |
| `--duplicate-of` | integer | no | none | the surviving issue this one duplicates; its content is folded there first |

**Output**

Prose, one line: `triage: killed #<n> — closed not-planned.` With `--duplicate-of`, preceded by
`triage: folded #<n> into #<m>.`

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the fold (if any) landed, and the issue closed not-planned |
| 2 | a guard refused before any write |
| 3 | the target resolves to `human` provenance and may not be killed |
| 4 | the fold succeeded but the close did not — content moved, issue still open |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `triage kill: #<n> is human-filed — park it instead; it may not be closed` | stderr | 3 | refusal |
| `triage kill: --confirm is required — it attests salvage was attempted` | stderr | 1 | usage |
| `triage kill: empty reason on stdin — a kill with no audit trail is unreviewable` | stderr | 2 | refusal |
| `triage kill: fold into #<m> failed — refusing to close and lose the content` | stderr | 2 | refusal |

**Scope**

The verb resolves provenance itself and **refuses on `human` or `ambiguous`** — the protection does
not depend on the caller having checked. It applies an audit marker alongside the close so a kill
sweep is reviewable after the fact.

The fold strictly precedes the close. A close that lands first with a failed fold destroys the
content the fold existed to save, so ordering here is a guarantee, not an implementation detail.

`--confirm` cannot be derived — footer presence alone never licenses a close, because a
human-invoked report carries the same footer — so the attestation is the caller's judgment,
recorded.

**Examples**

```
$ pipeline cli triage kill 4312 --confirm --duplicate-of 4290 <<'EOF'
Same observation as #4290, filed nine minutes apart by concurrent runs.
EOF
triage: folded #4312 into #4290.
triage: killed #4312 — closed not-planned.
```

**Grounding**

- Closing a duplicate without folding first loses whatever the duplicate said that the survivor did
  not — the common case being a second reproduction with different detail.
- Provenance is re-resolved inside the verb because a protection that relies on the caller having
  run a separate check is a protection that fails the first time somebody forgets.

---

## What stays judgment

No verb decides any of these:

- which of the six types holds, and what question excluded its nearest neighbour
- whether two problems are a bundle or two facets of one change
- what the rewrite says, and which claims traced to something actually read
- the priority band, and whether the work is addressed to an agent or a person
- whether salvage genuinely failed, which is what `--confirm` attests
- when an ambiguous provenance should be treated as human — the verb reports ambiguity; the skill
  resolves it toward protection
