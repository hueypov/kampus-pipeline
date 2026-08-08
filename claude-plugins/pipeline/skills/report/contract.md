# `report` — derived CLI contract

Serves: `skills/report/SKILL.md`. Derived 2026-08-07.

The verbs `report` needs, fully specified. A fresh implementing agent builds every one of these from
this document alone — without reading the session that wrote it, and without opening a v1 script.

Today the skill composes these three out of `tracker`, `intake-dedup` and `redact-leaks` at the call
site, which is why five separate guarantees currently rest on an agent remembering to chain them in
the right order. Each verb below moves one of those chains behind a single fail-closed call.

## Verb inventory

| Verb | Purpose | Split test — why deterministic, not judgment |
|---|---|---|
| `report dedup` | Is this observation already on the board? | Tokenizing a query, querying two sources, ranking and capping candidates, and reporting *which of three outcomes occurred* are all mechanical. Reading the candidates and deciding whether one is the same observation is the judgment, and stays in the skill. |
| `report file` | Compose, guard and create the intake issue, then prove what landed | The body template, the footer, the leak predicate, the empty-body check, the classification refusal, the intake stage and the post-write read-back are all mechanical. What goes *in* the six sections is the judgment. |
| `report note` | Add to the issue that already covered it | Same guards as `file`, minus the title and the stage. Deciding that an existing issue is the same observation is judgment; refusing a leaking or empty note is not. |

---

## `report dedup`

**Invocation**

```
pipeline cli report dedup --query <text> [--exclude <n>] [--limit <n>] [--stage <name>]
```

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--query` | string | yes | — | the observation text (title plus distinguishing keywords) to check for an existing open issue |
| `--exclude` | integer | no | none | an issue number to omit from results — the issue being deduped, so it never flags itself |
| `--limit` | integer | no | `20` | maximum candidates to print |
| `--stage` | string | no | the repository's configured intake stage | the lifecycle stage whose queue is listed as the read-after-write source |

**Output**

Machine-readable. **The first stdout line is always the outcome word**, one of `candidates`, `none`,
`indeterminate`. When the outcome is `candidates`, one `#<number>\t<title>` line follows per
candidate, best match first. Any diagnostic goes to stderr.

An empty candidate list is never ambiguous, because the outcome word carries the meaning: `none`
means both sources were read and nothing matched; `indeterminate` means the query carried no usable
keywords, so nothing was compared.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the check ran and returned a real answer — `candidates` or `none` |
| 8 | `indeterminate` — the check could not discriminate, so it did not run |
| 11 | a source read failed; the answer is UNKNOWN |
| 1 | usage error |

Exit 8 is the load-bearing one. A query with no usable keywords must be **impossible** to read as
"no duplicate found" at the exit-code level, not merely distinguishable by inspecting stderr.

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `report dedup: too few distinctive keywords in --query (<n>: [<tokens>]) — nothing was compared` | stderr | 8 | refusal |
| `report dedup: could not read a source (<reason>) — outcome UNKNOWN` | stderr | 11 | refusal |
| `report dedup: --query is required` | stderr | 1 | usage |
| `report dedup: --limit must be a positive integer` | stderr | 1 | usage |

**The `indeterminate` threshold is a count, not an empty set.** A query is indeterminate below
**three** usable tokens after stopword removal. An earlier draft of this spec said "no usable
keywords", and implementing it exposed that as wrong: `"it did the thing"` survives tokenization as
`did thing` — neither word is a stopword and both clear the length floor — so a zero-token test
never fires and the verb reports a confident `none` from a query that compared nothing. Growing the
stoplist instead would be endless; the defect is the count of discriminating terms, not which
particular words slipped through.

**Scope**

Two sources, fused: the intake-stage queue (read-after-write consistent, so it catches an issue
filed seconds ago) and the provider's search index (eventually consistent, but reaches older open
issues that already left the queue). Zero scope — both sources readable but empty — is `none`, not
`indeterminate`: nothing matched because there is nothing to match.

**Examples**

```
$ pipeline cli report dedup --query "http worker aborted request surfaces as plain timeout"
none
```

```
$ pipeline cli report dedup --query "worktree reaper leaves worktrees behind" --exclude 412
candidates
#398	Reaper skips worktrees whose branch was already deleted
#377	worktree-sweep dry-run reports paths it will not remove
```

```
$ pipeline cli report dedup --query "it did the thing"
indeterminate
$ echo $?
8
```

**Grounding**

- The existing `intake-dedup check` exits 0 with empty stdout for both "nothing matched" and "no
  usable keywords", so the two are separable only by reading a stderr string. Exit 8 removes that.
- `--stage` exists because the current implementation hardcodes the intake label in source, so any
  repo whose stages are named differently gets a check that silently matches nothing.

---

## `report file`

**Invocation**

```
pipeline cli report file --title <text> [--redact] [--dry-run]
```

The body arrives on **stdin**. There is no `--body` and no `--body-file`: a value that can be a path
is a value that can post the path instead of the contents.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--title` | string | yes | — | the issue title: specific, type-neutral, no classification prefix |
| `--redact` | boolean | no | `false` | mask machine-local paths to their class instead of refusing — for when such a path is itself the evidence |
| `--dry-run` | boolean | no | `false` | run every guard and print the composed body to stdout; create nothing |

**Output**

Prose, one line: `report: created #<n> — <url>`. Under `--dry-run`, the fully composed body
(sections plus footer) on stdout and `report: dry-run — no issue created` on stderr.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the issue was created and read back clean |
| 3 | stdin held nothing |
| 4 | a section is missing or empty, or the title classifies |
| 5 | the body carries a machine-local path and `--redact` was not given |
| 13 | the write succeeded but the read-back did not match what was sent |
| 1 | usage error |

Exit 13 is distinct from 3, 4 and 5 on purpose: a refusal means nothing happened, and a read-back mismatch
means something happened that must not be retried blindly.

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `report file: empty body on stdin — nothing to file` | stderr | 3 | refusal |
| `report file: missing required section '<name>'` | stderr | 4 | refusal |
| `report file: section '<name>' is empty` | stderr | 4 | refusal |
| `report file: machine-local path in body (<class>) — fix it, or pass --redact if the path is the evidence` | stderr | 5 | refusal |
| `report file: title carries a classification prefix ('<prefix>') — type is triage's call` | stderr | 4 | refusal |
| `report file: read-back mismatch on #<n> — created, but the landed body differs` | stderr | 13 | refusal |
| `report file: --title is required` | stderr | 1 | usage |

An unread stdin pipe is byte-identical to an empty one, so the empty-body refusal is what stops a
body that never arrived from filing as a successful, bodyless issue.

**Composition — what the verb adds**

1. The six sections are **validated, not generated**: `Summary`, `What I was doing`, `What I
   observed`, `Why it matters`, `Pointers`, `Suggested next step (non-binding)`. All must be present
   and non-empty except the last, which may be empty.
2. The **provenance footer is appended** after the sections and a blank line, always, with no flag
   to suppress it. It carries machine context only — session, branch, timestamp — dropping any field
   the environment does not expose, with no dangling labels and no `unknown` placeholders. It never
   carries an email address, an author name, or a path.
3. The issue is created at the repository's configured **intake stage**. There is no `--stage`: a
   verb that could file somewhere else would let a caller skip triage.

```
---
<sub>Filed by an agent · session `a0bd6818` · branch `pipeline/412-reaper` · 2026-08-07T16:44:13Z</sub>
```

**Scope**

The leak predicate scans the composed body **and** the title. Its classes are absolute user-home
paths, temp paths carrying a user hash, and sibling-clone source trees. Under `--redact` each match
is replaced by its class (`/Users/<redacted>/…`), which keeps the evidence that such a path was
posted while removing what identifies the machine — redaction never silently deletes.

**Examples**

```
$ pipeline cli report file --title "Reaper leaves worktrees behind after a failed sweep" <<'EOF'
## Summary
…
EOF
report: created #413 — https://github.com/hueypov/kampus-pipeline/issues/413
```

```
$ printf '## Summary\ncrashed writing /Users/huey/Library/Caches/x/state.json\n…' \
  | pipeline cli report file --title "Scratch state written outside the repo"
report file: machine-local path in body (user-home) — fix it, or pass --redact if the path is the evidence
$ echo $?
2
```

**Grounding**

- `tracker create-issue` today refuses neither an empty body nor a machine-local path, though
  `tracker post-verdict` refuses both. The asymmetry is the defect.
- The footer must be verb-owned: `triage` keys auto-close eligibility on it, so an issue filed
  without one is permanently mistaken for a human's and can never be closed. Appended by a caller,
  that guarantee is one forgotten command away, and the failure is invisible at filing time.
- No `--body` flag: passing a body as a path is how a path posts instead of its contents.

---

## `report note`

**Invocation**

```
pipeline cli report note --issue <n> [--redact] [--dry-run]
```

Body on **stdin**, same as `file`.

**Inputs**

| Flag | Type | Required | Default | Description |
|---|---|---|---|---|
| `--issue` | integer | yes | — | the existing issue this observation belongs to |
| `--redact` | boolean | no | `false` | mask machine-local paths to their class instead of refusing |
| `--dry-run` | boolean | no | `false` | run every guard and print the composed note; write nothing |

**Output**

Prose, one line: `report: noted on #<n> — <url>`.

**Exit status**

| Code | Trigger |
|---|---|
| 0 | the comment was created and read back clean |
| 3 | stdin held nothing |
| 5 | the body carries a machine-local path |
| 7 | `--issue` names an issue that is closed or does not exist |
| 13 | written, but the read-back did not match |
| 1 | usage error |

**Errors**

| Message | Stream | Code | Kind |
|---|---|---|---|
| `report note: empty body on stdin — nothing to add` | stderr | 3 | refusal |
| `report note: machine-local path in body (<class>) — fix it, or pass --redact` | stderr | 5 | refusal |
| `report note: #<n> is closed — a note on a closed issue reaches nobody` | stderr | 7 | refusal |
| `report note: #<n> not found` | stderr | 7 | refusal |
| `report note: --issue is required` | stderr | 1 | usage |

**Scope**

The same leak predicate as `file`, over the note body. The six-section requirement does **not**
apply: a note adds what the existing issue lacks, and forcing the full template onto it produces
four empty sections restating what is already there.

The footer **is** appended, for the same reason as `file` — a note is an agent's writing and its
provenance is read the same way.

**Examples**

```
$ pipeline cli report note --issue 398 <<'EOF'
Hit this again on today's run; the branch was deleted before the sweep, same as #398 describes.
EOF
report: noted on #398 — https://github.com/hueypov/kampus-pipeline/issues/398#issuecomment-…
```

**Grounding**

- Exit 7 exists because a note on a closed issue silently reaches nobody: the write succeeds, the
  observation is recorded where no queue reads it, and the filer sees success.
- No six-section requirement on a note — the template serves a first filing, not an addition.

---

## What stays judgment

No verb decides any of these, and the `SKILL.md` carries all of them:

- what goes in each of the six sections, and whether the observation is worth filing at all
- whether a printed candidate is genuinely the same observation
- whether a machine-local path is incidental (fix it) or the evidence itself (`--redact`)
- when an `indeterminate` result is worth a re-query versus filing anyway
- returning to the interrupted task rather than continuing into triage
