# `ship-it` — derived CLI contract

Serves: `skills/ship-it/SKILL.md`. Derived 2026-08-07.

Two verbs. `ship-it` is the stage with the least judgment in the pipeline and the most consequence,
so nearly all of it belongs on this side of the split: every precondition is a fact, and the skill's
only real work is routing a refusal to the stage that owns it.

The v1 skill was 1972 lines, almost entirely assertions written as prose for an agent to perform.
That is the shape this contract exists to invert.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `ship-it check` | May this PR merge? | Resolving which gates a diff requires, asserting each has a current-head PASS, reading CI state and any configured approval are all facts. Which PR to ship is the caller's. |
| `ship-it merge` | Merge it, and prove it landed | Re-asserting the preconditions, merging, and reading back are mechanical. Nothing here is a call. |

**Consumed unchanged:** `verdict read` (the gate assertion), `class-probe classify` (which gates a
diff requires), `tracker readPullRequest`.

## The exit table

Both verbs allocate from one table, so a code means one thing whichever produced it. Codes `0` and
`1` are reserved by the interface convention.

| Code | Name | Means |
|---|---|---|
| 0 | — | every precondition passed (`check`), or the merge landed (`merge`) |
| 1 | — | usage error, or the verb failed to run |
| 16 | `GATE_MISSING` | a required gate has no verdict — the PR was never gated |
| 14 | `GATE_FAIL` | a required gate's current verdict is FAIL |
| 15 | `GATE_STALE` | a verdict exists but is bound to a head that is not current |
| 18 | `CHECKS_FAILED` | a required check failed |
| 9 | `NOT_YET` | a required check has not finished — "not yet", never "no" |
| 10 | `REFUSED_POLICY` | repository policy requires an approval this PR does not carry |
| 12 | `WRITE_UNKNOWN` | the merge was attempted and the outcome could not be confirmed |
| 7 | `ZERO_SCOPE` | the provider reports the PR cannot merge (conflicts, closed, draft) |
| 11 | `PRECONDITION_UNKNOWN` | a precondition could not be READ — the answer is unknown, not satisfied |

`18` and `9` are separate because their owners differ: red is a defect for the author, pending is
nobody's yet. `12` and `11` are separate from `1` for the reason the reference implementation
states — "the provider refused" must never read as "the binary is broken", and a write whose
outcome is unknown must not be blindly retried.

---

## `ship-it check`

**Invocation**

```
pipeline cli ship-it check --pr <n> [--json]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request to test |
| `--json` | boolean | no | `false` | emit the full precondition matrix instead of prose |

**Output**

Prose by default: one line per precondition, in evaluation order, each `ok` or `REFUSED` with its
reason. Under `--json`, an object with one entry per precondition and the resolved gate list.

**Exit status**

0 when every precondition passed; otherwise the code of the **first** refusal, from the table above.
Evaluation stops there — a caller acts on one owner at a time, and a wall of refusals obscures which
stage the PR actually belongs to.

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `ship-it check: #<n> requires gate '<g>' and it has no verdict` | stderr | 3 | refusal |
| `ship-it check: #<n> gate '<g>' is FAIL at the current head` | stderr | 4 | refusal |
| `ship-it check: #<n> gate '<g>' is bound to <sha>, not the current head` | stderr | 5 | refusal |
| `ship-it check: #<n> has a failing required check '<name>'` | stderr | 6 | refusal |
| `ship-it check: #<n> has a pending required check '<name>' — not yet` | stderr | 7 | refusal |
| `ship-it check: #<n> requires an approval and carries none` | stderr | 8 | refusal |
| `ship-it check: #<n> is not mergeable (<state>)` | stderr | 10 | refusal |
| `ship-it check: could not read <precondition> for #<n> — UNKNOWN` | stderr | 11 | refusal |

**Scope**

Which gates are required comes from classifying the PR's changed paths, so it is the repository's own
classification policy rather than a list frozen here. A PR touching two classes needs a current-head
PASS in both.

**Both sides of the policy, unioned.** A pull request has two policies — the one at its base and the
one at its head — and they differ precisely when the PR changes the policy. Each is read from its own
commit, and a namespace either side requires is required. Reading the policy from the caller's
checkout instead made a policy-changing PR gated by the rule it was replacing, which is how #93
merged requiring two namespaces where its own head policy requires three. The union is the
fail-closed reading and needs no ruling on which side is authoritative; where the sides disagree,
`check` says so on its `policy scope:` line rather than taking the union silently.

`verdict post` resolves the same two refs through the same function, so a reviewer and a shipper
cannot compute different required sets for one PR.

**Zero scope fails closed.** A PR whose changed-path read returns nothing is `PRECONDITION_UNKNOWN`,
not "no gates required" — the second reading would let an unreadable diff merge ungated. So is a PR
that cannot be read at all: without it neither policy has a ref to resolve against.

**Examples**

```
$ pipeline cli ship-it check --pr 431
policy scope: base d112a19 and head 30e98f4 agree — code
gates required: code
gate code            ok    PASS @ 30e98f4 (current head)
checks               ok    1 required, all green
approval             ok    not required by policy
mergeable            ok    clean
```

```
$ pipeline cli ship-it check --pr 93
policy scope: base d112a19 → code, doc; head 66b0f0d → code, doc, skill; union required because skill is required by one side only
gates required: code, doc, skill
```

```
$ pipeline cli ship-it check --pr 447
gates required: code
gate code            REFUSED  bound to e1db540, not the current head 30e98f4
$ echo $?
15
```

**Grounding**

- Evaluation stops at the first refusal because each code names a different owner; reporting all of
  them at once asks the caller to decide which one to act on, which is the judgment this verb exists
  to remove.
- Pending is not red. Collapsing them would send an author to debug a check that had not run.

---

## `ship-it merge`

**Invocation**

```
pipeline cli ship-it merge --pr <n> [--method squash|merge|rebase] [--dry-run]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--pr` | integer | yes | — | the pull request to merge |
| `--method` | string | no | `squash` | the merge method |
| `--dry-run` | boolean | no | `false` | run every precondition and report; merge nothing |

**Output**

Prose, one line: `ship-it: merged #<n> as <sha> — closed #<issue>`, or without the closing clause
when the PR carries no closing reference.

**Exit status**

Every code `check` can return, plus:

| Code | Trigger |
|---|---|
| 0 | the merge landed and was read back |
| 12 | the merge was attempted and could not be confirmed |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| *(every `check` refusal, verbatim)* | stderr | 7, 9–11, 14–16, 18 | refusal |
| `ship-it merge: #<n> merge attempted; outcome UNCONFIRMED — do not retry blindly, read the PR` | stderr | 12 | refusal |

**Scope**

The preconditions are re-run **immediately before** the merge, not trusted from an earlier `check`.
The head can move in between, and a verdict bound to the old head is not a verdict — so a check-then-
merge sequence that trusted the earlier answer would be exactly the staleness hole the gate contract
exists to close.

After merging, the PR is read back and its merged state asserted. A merge that was requested but
cannot be confirmed is code 9, never 0: the difference between "it merged" and "the API accepted my
request" is the difference this verb exists to make.

**Examples**

```
$ pipeline cli ship-it merge --pr 431
ship-it: merged #431 as a1b2c3d — closed #412
```

**Grounding**

- Re-running the preconditions is not redundancy. It is the only thing that makes the gate's
  head-binding meaningful at the moment of the merge rather than at the moment of the check.

---

## What stays judgment

- which PR to ship
- what to do with each refusal — every code names an owner, and routing to it is the skill's work
- declining to merge a PR this session authored, even when the gate legitimately passed
