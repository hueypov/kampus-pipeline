# `plan-epic` — derived CLI contract

Serves: `skills/plan-epic/SKILL.md`. Derived 2026-08-08.

Two new verbs. `plan-epic` carries more genuine judgment than any other stage — what the epic is
for, and where the seams between children fall, are irreducibly the model's — so the split here is
drawn tighter than usual: everything that is *not* those two decisions belongs on this side.

The v1 skill was 1165 lines. Most of that length was not judgment; it was the mechanics of the child
shape, the lock protocol, and a read-modify-write against a live issue body, all written as prose
for an agent to perform by hand. Three of those already have verbs. The two below are what was left.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `plan-epic child` | File one sub-issue of an epic and link it | Whether a body carries an acceptance criterion, whether a story trace is present, whether a child by this title already exists, and whether the native link landed are all facts. *What* the child is, and what its criteria say, is the caller's. |
| `plan-epic write` | Splice the plan into the epic body and prove the brief survived | Read, splice on the heading boundary, PATCH, read back, compare. Every step is mechanical, and the comparison has exactly one right answer. |

**Consumed unchanged:** `epic-lock acquire|release` (serialization), `epic-splice apply` (the pure
text transform inside `write`), `epic-ledger --dry-run` (the structural gate, run as a pre-flight),
`tracker create-issue`.

### Why `write` exists at all

`epic-splice apply` is already the correct pure core: it slices the live body on the heading
boundary so every byte outside the replaced section survives, and it refuses a corrupt-heading body
rather than orphaning or doubling a section. But it **prints** — the read, the `PATCH`, the
read-back, and the concurrency recheck around it were left in the skill's prose, by its own note.

That is the split drawn one step too early. The transform is the easy half; the half that loses a
brief is the write. `triage enrich` already sets the precedent — compose, write, read back, prove
the original survived — and an epic's brief is the higher-value artifact of the two, because a whole
fleet reads it.

## The exit table

Both verbs allocate from the shared table in `packages/pipeline-cli/src/exit-codes.ts`, which is
authoritative; this is a view of it. Codes `0` and `1` are reserved by the interface convention.

| Code | Name | Means |
|---|---|---|
| 0 | — | the child was filed or already existed (`child`); the plan landed and read back (`write`) |
| 1 | — | usage error, or the verb failed to run |
| 3 | `EMPTY_INPUT` | stdin or a named file was empty — refusing to file a bodyless child or write an empty plan |
| 4 | `MALFORMED_INPUT` | the body lacks a required section, or the epic body's heading anchors are corrupt |
| 7 | `ZERO_SCOPE` | no story trace was given — the child would be untraceable work |
| 11 | `PRECONDITION_UNKNOWN` | the epic, its children, or its live body could not be READ |
| 12 | `WRITE_UNKNOWN` | the write was attempted and its outcome could not be confirmed |
| 13 | `READBACK_MISMATCH` | the write landed and the brief did not survive it |

`11` is separate from `1` for the usual reason: "could not read the epic's children" must not read
as "the epic has no children", which is the answer that makes create-once file a duplicate.

`13` is separate from `12` because the owners differ. An unconfirmed write may be safe to retry; a
confirmed write that ate the brief is damage, and retrying compounds it.

---

## `plan-epic child`

**Invocation**

```
pipeline cli plan-epic child <epic> --title <text> --stories <n[,n…]> --type <t> [--priority <p>] [--dry-run]
```

The body arrives on **stdin**, never as a path. It is multi-line markdown with fenced blocks, and a
named temp file is the shared-name collision two concurrent planners would find (the `report`
precedent). An unread pipe is byte-identical to an empty one, so an empty stdin is a refusal.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<epic>` | integer | yes | — | the parent epic |
| `--title` | string | yes | — | the child's title; also the create-once key |
| `--stories` | list of integers | yes | — | the plan's story numbers this child implements |
| `--type` | string | yes | — | `bug`\|`feature`\|`chore`\|`decision`\|`investigation` — **not `epic`** |
| `--priority` | string | no | `p2` | the priority band |
| `--dry-run` | boolean | no | `false` | validate and print the composed body; create nothing |

A plan child is filed **already triaged**, carrying its type and priority. It has been classified —
by the plan that produced it, under a lock, by an agent that read the codebase — so routing it
through intake would ask a triager to re-derive a decision already made. This is not merely
redundant: `epic-ledger` fails a ledger whose children still carry the intake label, so the round
trip leaves the plan invalid until somebody undoes it. That defect was found by running the gate
against a real epic while writing this, which is the argument for the pre-flight the skill mandates.

`epic` is excluded from `--type` deliberately. A child that is itself an epic is a plan that stopped
before it finished, and accepting one would let the stage report success on work it did not do.

**Output**

`plan-epic: filed #<n> — <title>` on a create, `plan-epic: reusing #<n> — <title>` when create-once
matched. Both exit 0: the caller asked for the child to exist, and it does.

**Exit status**

0 on filed-or-reused. `3` on empty stdin, `4` when the body carries no acceptance criterion or no
`### What to build`, `7` when `--stories` resolves to nothing, `11` when the existing children could
not be listed, `12` when the issue was created and the sub-issue link could not be confirmed.

**Errors**

Each refusal names the invariant, not the field. "no acceptance criterion — a child without one is
picked up and the agent decides for itself what done meant" beats "validation failed".

`12` is the one that needs care: the issue exists and the link does not, so the message must say
both, and must not suggest a retry that would file a second issue. The create-once key makes a
re-run safe, and the message should say so.

**Scope**

Files one child. It does not write the epic body, does not decide the split, does not close or
supersede an existing child on a re-plan, and does not validate the topology — `epic-ledger` does.

**Examples**

```bash
pipeline cli plan-epic child 412 --title "One user saves one bookmark and sees it" --stories 2 <<'MD'
### What to build
Persist a bookmark for the signed-in user and render it in the saved-items list.

### Acceptance criteria
- [ ] a signed-in user can save a definition
- [ ] the saved definition appears in the saved-items list after a reload
MD
```

**Grounding**

The two shape invariants are the ones `epic-ledger`'s structural gate fails a plan on
(`countAcceptanceCriteria`, `parseChildStories`). Enforcing them at the write is what turns a gate
finding into an impossibility: the planner learns at the moment it can still fix it, holding the
lock, rather than at the gate after the fleet has the ledger.

Create-once keyed on `(epic, title)` mirrors `split-guard`'s `(parent, title)` key, and for the same
reason: a retry or a re-emitted step is otherwise a byte-identical twin.

---

## `plan-epic write`

**Invocation**

```
pipeline cli plan-epic write <epic> --deps-file <path> [--plan-file <path>] [--dry-run]
```

Files rather than stdin here, because there are two blocks and `epic-splice apply` already takes
them that way.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `<epic>` | integer | yes | — | the epic whose body to write |
| `--deps-file` | path | yes | — | the freshly-derived `## Dependencies` block |
| `--plan-file` | path | no | — | the `## Plan (plan-epic)` block |
| `--dry-run` | boolean | no | `false` | print the body that would be written; write nothing |

**Append-vs-replace is read from the body, not from the flags.** `epic-splice` treats a plan block
as a re-plan signal and refuses when the sections it would replace are absent — correct for it, and
wrong as a contract for this verb, because a *first* plan legitimately supplies both blocks with
neither present yet. So `write` decides from the epic: no `## Dependencies` and no
`## Plan (plan-epic)` heading means first plan, and both blocks are appended; otherwise the splice
owns the decision and its corruption rules unchanged.

The first version of this contract made `--plan-file` mean "re-plan", and the first live run refused
a first plan because of it. Recording that here because the flag still reads like a mode switch and
is not one.

**Output**

`plan-epic: wrote #<n> — brief preserved (<k> bytes), dependencies <appended|replaced>`.

The byte count is not decoration. It is the evidence the read-back compared, and printing it is what
lets a reader tell "checked and identical" from "did not check".

**Exit status**

0 when the body landed and the brief read back identical. `3` on an empty deps file, `4` on corrupt
heading anchors, `11` when the live body could not be read, `12` when the `PATCH` outcome could not
be confirmed, `13` when the write landed and the brief did not survive.

**Errors**

`13` prints where the divergence starts, not just that there was one. A planner that has to diff two
issue bodies by hand to find out what it destroyed will not do it.

**Scope**

Writes one epic body. It does not acquire the lock (`epic-lock` does, and the caller must already
hold it), does not create children, and does not validate the topology it just pinned — running the
gate is a separate act, deliberately, so that "I wrote it" and "it is valid" cannot be confused.

**Grounding**

The transform, the anchor-count guards, and the append-vs-replace decision are `epic-splice apply`'s
and are consumed unchanged. What is new is the IO around them and the read-back proof — the part its
own header notes was left to the skill.

The append-only rule on the brief is the same invariant `triage enrich` holds from the other side:
triage wraps an epic's brief in place rather than rewriting over it precisely so that this stage has
something to preserve.

---

## What this contract deliberately does not specify

**A re-plan reconcile verb.** Superseding, unlinking, or closing a child that a new plan no longer
needs is a judgment about whether work already done still counts. Create-once makes a re-run safe
against duplication, which is the mechanical half; the rest is not mechanical and there is no
evidence yet about what the right behaviour is. Specifying it now would be inventing a rule and
giving it a verb's authority.

**A ledger-listing verb.** `epic-ledger` already reads the children and validates them. A second
reader would be a second answer to the same question.
