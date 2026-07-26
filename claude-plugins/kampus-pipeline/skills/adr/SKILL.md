---
name: adr
description: Record an architecture decision in `.decisions/`. Trigger when the user says "/adr", "save this as an ADR", "record this decision", "ADR for X", or after a meaningful technical preference / convention is stated that future agents should respect.
---

# adr

Capture one decision per file in `.decisions/`. There is no committed index and the portable toolkit installs **no `SessionStart` ADR-map hook**: discovery is the repository's `CLAUDE.md` contract, the same in every context, using `ls .decisions/` plus each file's frontmatter (`id`/`title`/`status`). `pipeline-cli decisions-index compact` renders the full `id · title · status` map **on demand** and never injects or commits it. An ADR change is **purely additive**: it adds one `.decisions/NNNN-slug.md` file (plus the superseded file's status edit when superseding), and never touches or regenerates an index.

## Steps

1. **Allocate the next number from the repository's decision files; optionally coordinate it through the repository's PR workflow.** Numbers are four-digit, zero-padded, and monotonic. The portable baseline is the **merged set**: the `NNNN` prefixes in `.decisions/NNNN-*.md` on the base you intend to change. Do not eyeball it — run **`pipeline-cli decisions-index next`** (in an initialized consumer, `pnpm pipeline cli decisions-index next`). It uses the same frontmatter parser as `validate` and prints `max(id) + 1` (for example, `0155`). Refresh or select the repository's intended base by its own normal Git practice before allocating; never assume a branch name, remote name, or hosting-provider convention.

   If the repository uses GitHub pull requests to coordinate ADR work **and** `gh` is authenticated, inspect open ADR PRs using that repository's documented query convention. Treat an open PR that adds `.decisions/NNNN-*.md` as a provisional reservation, then choose one greater than both the local allocator and every discovered in-flight number. Resolve the target with `${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}` only when performing that optional GitHub operation; do not hard-code a repository name. The repository may choose REST or GraphQL according to its own integration constraints. If GitHub is unavailable, the repository has no PR convention, or the query cannot be completed, report that coordination was unavailable and continue with the local allocator — do not invent an organisation policy or block a repository-local ADR.

   This is **detect-and-serialize, not a compare-and-swap**: even a successful PR scan narrows rather than eliminates the collision window. The generated `decisions-index validate` CI step is the universal backstop: it rejects duplicate IDs and filename/frontmatter mismatches before merge, so the later author can renumber explicitly. A repository that needs stronger serialization may add its own documented adapter; it must not be silently assumed by this portable skill.

   **Record how the number was chosen in the hand-off.** State the base that supplied the local allocator result, the number `next` printed, whether optional PR coordination ran, and any in-flight numbers it found. This is not a second source of truth and it is not a lock file: it gives the reviewer enough context to recognize a collision without turning an ADR change into a shared generated-artifact update. If coordination was not attempted, say why in plain terms — for example, the repository has no PR convention, GitHub authentication was unavailable, or the repository's guidance did not request a scan. Do not describe that outcome as an error when the local allocator and validation path remain available.

   **Keep the two safeguards distinct.** The allocator answers “what is the next number in the decision files I can see?” The optional PR scan answers “does this repository currently advertise an in-flight number through its own collaboration system?” The validator answers “is the resulting tree internally consistent?” None of those steps authorizes a merge, replaces code review, or imposes a particular remote-workflow topology. This separation allows a repository to use direct commits, another forge, an offline change review, or GitHub pull requests without changing the ADR file format or the portable command contract.
2. Pick a kebab-case slug from the title (≤ 5 words).
3. Write `.decisions/NNNN-slug.md` using the template below. Directly beneath the `# NNNN — <Title>` heading, write the **required** plain one-line `**What this decides:** …` summary (see the [Rules](#rules)). The frontmatter `title`/`status`/`date` are the **source of truth** for the on-demand `compact` map row, so write the exact display text you want there (including any inline Markdown). Keep `title` to **one dense line** — it is what the rendered `compact` map shows for this ADR.
4. **Keep the ADR change purely additive — add only `.decisions/NNNN-slug.md`** (plus the superseded file's status edit when superseding). There is no committed `.decisions/index.md` to regenerate or commit; discovery is the `CLAUDE.md` contract — `ls .decisions/` plus frontmatter, with `compact` on demand — so no shared generated file changes. Concurrent authors can still choose the same number, which is why the validator remains required. To **render** the compact map locally you may run the CLI, but there is no index file to stage:
   ```bash
   # OPTIONAL local render of the on-demand compact map — nothing to `git add` (no committed index)
   if [ -x .pipeline/toolkit/bin/pipeline ]; then
     pnpm pipeline cli decisions-index compact   # the adopting repository-local: the in-repo consolidated bin
   else
     .pipeline/toolkit/bin/pipeline cli decisions-index compact      # portable private toolkit
   fi
   ```
   The published CLI operates on the local `.decisions/` filesystem (no GitHub target), so there is no `$REPO`/`$CLAUDE_PIPELINE_REPO` resolution here — it is purely the in-repo-vs-published invocation swap.
5. **Record the ADR's vocabulary impact (required — a named term or an explicit "none").** An ADR is a primary *coining site*: it is where a concept most often enters the repository vocabulary — a new term, or a redefinition of an existing one. Before reporting the path, run the point-of-coining glossary check defined in [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source). This is a **coining-time authoring hook, not a code-review gate**: it belongs in the ADR authoring flow and never changes another workflow's gate semantics. **You must land on one of two explicit outcomes — a named term routed to the glossary, or a recorded "no vocabulary impact"; silently skipping it is not an option.**
6. Tell the user the path. Do not summarize the body — they just stated it.

## Vocabulary impact — catch a coined or redefined term at its source

The glossary (`.glossary/TERMS.md`) is the repository-owned domain vocabulary every contributor and CI-spawned agent shares. A review workflow that notices only **structural** surfaces — a new feature folder, package, or export — can miss a **concept-level** term coined or redefined *within existing surfaces* (a renamed model, a redefined lever, or an ADR-coined phrase). An ADR is where those terms are named, so catch them **here, at coinage**, while the author still holds the concept, rather than in a later archaeology pass.

This is a **required, not-silently-skippable** authoring step. When you write the ADR, ask: *does this decision coin a new term, or redefine an existing one?* You must record **exactly one** of two outcomes — you cannot leave it blank:

- **Term(s) coined/redefined → feed the glossary.** Name each term (and, for a redefinition, what changed). Then route it to `.glossary/TERMS.md`: if the term's canonical definition is short and unambiguous, add or update its row directly in the same ADR change; if it needs fuller treatment (a "not …" disambiguation or cross-links), invoke `/glossary` when that skill is installed, or record a repository-appropriate follow-up. Either way the term is surfaced, never left implicit in the ADR prose.
- **No vocabulary impact → record it explicitly.** If the ADR coins/redefines nothing (it re-decides mechanics, sequencing, or policy over already-named concepts), state that plainly — record it in the ADR's terminal `## Records` section (see the [Rules](#rules)) and tell the user "no vocabulary impact" as part of Step 6's report. The explicit "none" is the recorded outcome; it is what distinguishes *"considered and there is none"* from *"forgot to check."*

This hook is **off the fail-closed gate by construction**: it is authoring-time judgment in this skill, it blocks no PR, and it does not alter another workflow's gate. It is the routed-term half of a vocabulary practice that captures newly coined or redefined terms at their source; any repository-specific review backstop is a separate concern.

## File template

```markdown
---
id: NNNN
title: <one decision-carrying clause, ≤ ~12 words — this is the compact-map row>
status: accepted
date: YYYY-MM-DD
tags: [<area>, <area>]
---

# NNNN — <Title, verbatim from the frontmatter `title`>

**What this decides:** <one plain human-language sentence a non-author can parse cold — what the decision *is*, not a restatement of the dense `title`.>

## Context
<Why this came up — situation, constraint, prior pain.>

## Decision
**<One bolded declarative sentence — the decision itself, in a line.>**

<Then the mechanics / reasoning, declarative. No hedging.>

<!-- When (and only when) this ADR constrains future work, follow the reasoning with an
     austere list — terse, one line per item — under a bolded label. Omit it entirely if
     the ADR constrains nothing (the related safeguards form):
**Binding constraints.**
- <constraint>
**Banned.**
- <what this rules out> -->

## Consequences
<What this makes easier / harder. Any migration cost.>

<!-- Optional terminal sections — add only when they carry content, in this order:

## Records
     Merge-time bookkeeping, quarantined out of the decision body: backlog reconciliation
     (`Closes/Reshapes #N`), blocks-cleared, and the Step-5 vocabulary-impact outcome (the
     term routed to .glossary/TERMS.md, or an explicit "no vocabulary impact").

## Amendments
     The one sanctioned currency shape — a dated forward note when a later change refines
     this ADR; the decision above still stands (0107's form, never a top-of-file blockquote):
- **#NNNN — <what changed> (YYYY-MM-DD).** <the refinement.> -->
```

## Discovery — the CLAUDE.md contract, no committed index

There is no committed `.decisions/index.md` and **no `SessionStart` ADR-map hook**. Discovery is the `CLAUDE.md` contract alone, uniform across every context (session, subagent, CI): `ls .decisions/` (the `NNNN-slug` filenames are the map) plus each file's frontmatter (`id`/`title`/`status`) for the row. For the full one-line-per-ADR `id · title · status` map **on demand**, run `pipeline-cli decisions-index compact` (derived straight from frontmatter, ordered ascending by `id`) — never auto-injected. Nothing is generated, committed, or regenerated, so there is no index-drift maintenance task and an ADR change remains purely additive.

The CLI commands have deliberately separate responsibilities. `compact` is a read-only view for a human or agent that needs orientation; it is not a required session hook. `next` is a deterministic local allocator; it does not query a hosting provider or claim an exclusive lease. `validate` checks the file names and frontmatter that will become part of the repository record; it is the required consistency boundary for the generated workflow. A consumer may expose these commands through `pnpm pipeline`, the pinned toolkit binary, or a repository-owned wrapper, but the wrapper must preserve the same repository-relative `.decisions/` semantics.

This division also keeps failures understandable. A malformed decision file makes `compact`, `next`, and `validate` fail because the repository record needs repair before it can be read, allocated from, or merged safely. An absent GitHub login affects only an optional coordination query and must never be misreported as a malformed decision tree. A missing generated workflow is a repository integration gap: record it for the repository owner and use the local validator before handing off the change. Do not solve any of these conditions by creating an index file, renumbering a historical decision without review, or weakening the filename/frontmatter consistency rule.

The map's `title`/`status` fields are the file's frontmatter values **verbatim** — so a linked supersede status (`superseded by [0009](0009-slug.md)`) is written in the file's `status:` field and the rendered map carries it through. Keep `title` to one dense line.

### ADR number lock

When the generated document-safety workflow runs on a **PR**, it invokes `decisions-index validate`, which fails the build on a duplicate `id` or a filename/frontmatter number mismatch. This is the portable number-collision backstop for Step 1; it does not check any index because none is committed. A repository without that workflow must provide an equivalent documented validation step before it treats ADR changes as mergeable.

## Rules

- One decision per file. If the user is describing a sprawling design, that belongs in the vault, not here.
- **Every new ADR opens with a plain one-line `**What this decides:** …` summary, directly beneath the `# NNNN — <Title>` heading and above `## Context`.** Write it in plain human language — what the decision *is* — so a contributor who did not author it can parse it cold, without decoding the dense prose below it. It is a reader-facing summary, **not** a restatement of the one-line `title` (the `title` is the dense `compact`-map row; this is the human gloss). This line is required on every new ADR — never omit it.
- **Title discipline — `title` is one decision-carrying clause (≤ ~12 words); the `# NNNN — <Title>` H1 repeats it verbatim.** The frontmatter `title` *is* the `compact`-map row and renders verbatim, so it must **carry the decision, not name the topic** — `Every gate fails closed on zero scope` over `Gate scope handling` — and stay to a single dense clause. The H1 then matches it character-for-character; the human gloss lives in the `**What this decides:**` line above, not in a second, looser title.
- **`## Decision` opens with one bolded declarative sentence.** State the decision in a single bolded line *before* the mechanics so a reader gets the ruling in one line. When — and only when — the ADR constrains future work, follow the reasoning with an **austere** list (terse, one line per item) under a bolded `**Binding constraints.**` / `**Banned.**` label. This is authoring *guidance*, not a fail-closed template section: an ADR that constrains nothing carries no such list, and no validation fails merely because the list is absent.
- **Merge-time bookkeeping goes in a terminal `## Records` section, out of the decision body.** Backlog reconciliation (`Closes/Reshapes #N`), blocks-cleared, and the Step-5 vocabulary-impact outcome are housekeeping, not the decision — quarantine them in a terminal `## Records` so `## Decision`/`## Consequences` read as the decision alone. Omit the section when there's nothing to record.
- **Post-merge currency has one shape: a dated `## Amendments` note.** When a later change refines an *accepted* ADR (the decision itself still stands; an amendment refines mechanics or wording, not the ruling), append a dated forward note — `- **#NNNN — <what> (YYYY-MM-DD).** …` — to a terminal `## Amendments` section. **Never** prepend an ad-hoc `> **Update:** …` blockquote at the top of the file; a top-of-file update blockquote obscures the original decision and is banned.
- **Linking to another ADR — resolve its filename by stable number from disk, never guess the slug from the target's title.** A target ADR's slug is **not derivable from its title**: the stable number `NNNN` is the only reliable key. **Read the real filename off disk** and use it verbatim — never re-apply the Step-2 title-to-slug heuristic to a different ADR you are linking. This is an authoring-time defence against dead links; resolve every `[NNNN](NNNN-slug.md)` link's slug this way:
  ```bash
  ls .decisions/NNNN-*.md   # → .decisions/NNNN-real-slug.md — use exactly this filename in the link
  ```
- `status`: `accepted | proposed | superseded | deprecated` (or a richer linked phrase like `superseded by [NNNN](NNNN-slug.md)`). Default `accepted` unless the user says otherwise. Whatever you put in `status:` is what the on-demand `compact` map shows.
- Superseding an older ADR: in the new file write `Supersedes [NNNN](NNNN-slug.md).` in `## Context`, and edit the old file's frontmatter to `status: superseded by [NNNN](NNNN-slug.md)` plus a body line `Superseded by [NNNN](NNNN-slug.md).` The on-demand `compact` map reflects both from frontmatter — there is no index to touch. Resolve every `NNNN-slug.md` here off disk (`ls .decisions/NNNN-*.md`) per the cross-link rule above; a guessed slug is exactly where supersede links go dead.
- Date is today (`date` command if unsure).
- Never edit an accepted ADR's decision text after the fact — supersede instead.
- **Always resolve the vocabulary-impact outcome** (Step 5 / [§Vocabulary impact](#vocabulary-impact--catch-a-coined-or-redefined-term-at-its-source)): every ADR ends with *either* a term surfaced to `.glossary/TERMS.md` *or* an explicit recorded "no vocabulary impact." Never leave it unstated — the explicit "none" is a real outcome, not a skip.
- Your ADR change adds only the ADR file (plus the superseded file's status edit); there is no committed index. Optional local render of the on-demand compact map (nothing to stage): `pnpm pipeline cli decisions-index compact` when the consolidated bin is on disk, else `.pipeline/toolkit/bin/pipeline cli decisions-index compact`. If the repository uses a pull request, follow its documented review and merge process; this skill neither requires nor invents organisation-specific labels, boards, approvals, or API rules.
