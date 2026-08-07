---
name: glossary
description: Maintain the repo-owned domain-vocabulary file `.glossary/TERMS.md` — the canonical nouns of the codebase (products, entities, backend/infra terms) every contributor and CI-spawned agent shares. Two modes — bootstrap (seed TERMS.md from a fresh sweep of the feature surfaces when it is thin or absent) and incremental update (given a changed surface — a new feature folder, a new public export, a renamed symbol — add/rename/disambiguate the affected terms since the file's last update). Trigger on "update the glossary", "update TERMS.md", "add a term to the glossary", "bootstrap the glossary", "refresh the domain vocabulary", "the glossary lags the code", "/glossary". NOT a shipped product feature, NOT the architecture-vocabulary file `LANGUAGE.md`, and NOT an architecture audit — this skill only edits `.glossary/TERMS.md`.
---

# glossary

You maintain `.glossary/TERMS.md` — the repo-owned **domain vocabulary**: the canonical
nouns of the codebase (products, domain entities, backend / fate / testing / infra / CI
terms) that a contributor or a CI-spawned agent must share to read the code the same way.
A glossary nobody updates rots: it lags the shipped surfaces, the same concept drifts to
four names, and pointers into it stop resolving. Your job is to keep the *what*-vocabulary
current against the code that is the authority.

You operate on **one file and one file only**: `.glossary/TERMS.md`. You are **read-only on
application code** — you read the codebase to learn the vocabulary, you never change it. You
do **not** open a PR, run a gate, or touch GitHub issues as part of your core loop — this is
a working-tree doc-maintenance skill, not a pipeline-execution skill. (When a pipeline run
*dispatched* you to produce this edit, the surrounding repository workflow owns any PR; your
job ends at a correct, committed edit to `.glossary/TERMS.md`.)

## Scope — what this skill is, and what it is NOT

- **It maintains `.glossary/TERMS.md` only** — the **domain-noun** half of the vocabulary
  spine. It never edits `.glossary/LANGUAGE.md` (the architecture-vocabulary file: module /
  interface / depth / seam / adapter / leverage / locality). `LANGUAGE.md` is near-frozen and
  not skill-maintained; leave it untouched.
- **Terms, not conventions.** This repo's *conventions* already live in `CLAUDE.md` and
  `.patterns/`; this skill does **not** duplicate or maintain them. It is **terms-only** — the
  noun glossary, nothing else.
- **NOT a product feature.** `glossary` is the technical maintenance capability, deliberately
  distinct from any product, brand, user-facing dictionary, or domain feature the adopting
  repository may ship. Keep its name and terminology clear of local product nouns so a request
  to maintain contributor vocabulary cannot be mistaken for work on a customer-facing surface.
  Follow the adopting repository's documented naming and language conventions; this skill does
  not supply a default language split or reserve a product name of its own.
- **NOT an architecture audit.** It does not sweep the codebase for shallow modules / refactor
  candidates / deepening opportunities, and it does not file issues. That is a different skill's
  job — use `report`); this skill's surface is the vocabulary file, not the architecture.
- **NOT intake.** It does not file, classify, or prioritize GitHub issues — that is `report` /
  `triage`. The only thing it produces is an edit to `.glossary/TERMS.md`.

## Repo-agnostic — resolve the target once

This skill is **repo-agnostic** (the pipeline suite is an installable plugin — the repository-resolution rule that uses an explicit override or the current checkout, never a hardcoded repository). It
never hardcodes a repo. When you need a GitHub target (for example, to cite an issue number in a
term's disambiguation note), resolve it only for that optional operation. Prefer
`CLAUDE_PIPELINE_REPO`; otherwise resolve the current checkout:

```bash
REPO="${CLAUDE_PIPELINE_REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
```

In the adopting repository this defaults to `<owner>/<repository>` with no config, so the behavior is unchanged
(the repository-resolution rule that uses an explicit override or the current checkout, never a hardcoded repository §1). The **file path itself is repo-relative** — `.glossary/TERMS.md` at the repo
root — resolved from the working tree, never an absolute or home path. Resolve the repo root
with `git rev-parse --show-toplevel` and operate on `<root>/.glossary/TERMS.md`.

## The file you maintain

`.glossary/TERMS.md` is a markdown file: a short top-of-file note (what it is + that the **code
is authoritative when they disagree**), then **sectioned tables**, one row per term. Each row is
`| Term | Definition | Not |` — the term, its short canonical definition, and a **disambiguation**
column naming what the term is **not** (used to pin a known naming drift). Sections group terms
by area — e.g. *Core / shape*, *Products (domains)*, *Domain entities*, *Backend architecture*,
*Testing*, *Infra / CI*. Read the live file to learn its exact sections before editing; mirror its
existing shape, never reinvent the layout.

Two rules govern every edit:

- **The code is authoritative.** When the code and TERMS.md disagree, the code wins and TERMS.md
  is the doc to fix. You read the code to derive the term, never the reverse.
- **Repo-relative cross-references only.** A term's note may link into `.decisions/` or
  `.patterns/` with a **repo-relative markdown link** (`[...](../.decisions/NNNN-slug.md)` or `[...](../.decisions/)`); it must
  never carry a machine-absolute path, a home-directory path, a personal-vault path, or an Obsidian
  wikilink. Cite an ADR/issue by number, link by repo-relative path.

---

## Mode selection — bootstrap vs. incremental

Pick the mode from the state of the file and what you were asked to do:

- **Bootstrap** when `.glossary/TERMS.md` is **absent or thin** (no file, an empty stub, or only
  a handful of terms relative to the surfaces that exist) — *or* when you're explicitly asked to
  "bootstrap the glossary" / "seed TERMS.md". You sweep the feature surfaces once and populate the
  domain nouns from scratch.
- **Incremental update** when the file **already exists and is populated**, and the trigger is a
  *change*: a new feature folder, a new public export, a renamed symbol, "the glossary lags the
  code", or "add term X". You touch only the affected terms — add the new ones, rename the moved
  ones, disambiguate the drifted ones — and leave the rest of the file byte-for-byte intact.

When in doubt, prefer incremental: a populated file is rarely safe to regenerate wholesale (you'd
lose hand-curated disambiguation notes). Bootstrap is the cold-start case.

---

## Bootstrap mode — seed TERMS.md from a feature sweep

The first-run seed. Run it when there's no glossary worth preserving.

1. **Find the surfaces.** Enumerate the product/feature surfaces the vocabulary should cover —
   the feature folders, public exports, and domain modules. Derive their locations from the
   adopting repository's tree and contributor guidance, never from an assumed monorepo layout.
   Start with the tracked top-level directories, then inspect the directories that actually hold
   the repository's source and public interfaces:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   # Candidate top-level domains; inspect the live tree before choosing the code surfaces.
   git -C "$ROOT" ls-files | awk -F/ 'NF > 1 {print $1}' | sort -u
   ```

   If the repository documents source roots, use those roots. Otherwise inspect the candidate
   directories and select the ones containing implementation, public interfaces, or domain
   definitions. Do not treat documentation, vendored dependencies, generated output, or tooling
   metadata as a vocabulary surface merely because they are tracked.

2. **Harvest the nouns.** For each surface, read enough to name its domain nouns: the product
   name, its entities, the services/tables/exports a contributor must know. Capture the *canonical*
   name (the one the code actually uses) and a one-line definition grounded in what the code does.

3. **Group into the sectioned tables.** Place each term in the section it belongs to (Core,
   Products, Entities, Backend, Testing, Infra/CI). Where a name is known to have drifted — the
   same concept under two names, or a name that collides with another — fill the **Not** column to
   pin the canonical choice.

4. **Write the file** with the top-of-file note (what it is, that the code is authoritative) and
   the tables. Keep definitions short; the file is a glossary, not a manual. Edit
   `<root>/.glossary/TERMS.md` directly.

Bootstrap is the one mode that may write the whole file. Even so, prefer **alphabetized rows
within each section** so a later incremental diff is small and readable.

---

## Incremental-update mode — add/rename/disambiguate the changed terms

The steady state: the file exists, the code moved, and the glossary must catch up to **just**
the change. The discipline is surgical — touch the affected rows, preserve everything else.

1. **Scope the change to the diff since the file last moved.** The top-of-file note or the
   file's git history dates the last update; scan what changed since then, not the whole repo.
   The file's last-touch commit bounds the sweep:

   ```bash
   ROOT="$(git rev-parse --show-toplevel)"
   # the commit that last touched the glossary — the lower bound of "what changed since"
   LAST=$(git -C "$ROOT" log -1 --format=%H -- .glossary/TERMS.md)
   # Review changed paths, then retain only the repository's code/domain surfaces.
   git -C "$ROOT" diff --name-status "$LAST"..HEAD
   ```

   If the file has never been committed (you're staging a fresh seed), that's the bootstrap case,
   not this one. If `LAST` is empty for a reason other than absence, fall back to reviewing the
   working-tree diff (`git -C "$ROOT" diff --name-status HEAD`). Exclude non-code paths only
   after inspecting the repository's own layout; never rely on a fixed source-root pathspec.

2. **Classify each change against the vocabulary:**
   - **A new noun** (a new feature folder, a new public export, a new entity/table) → **add** a row
     in the right section with a code-grounded definition.
   - **A renamed symbol** (the code's canonical name moved) → **rename** the existing row to the new
     name, and — if the old name was in use — record it in the **Not** column so the drift is pinned.
   - **A drift / collision** (the same concept named two ways, or a name now colliding with another)
     → **disambiguate**: pick the canonical name (the one the code uses) and fill the **Not** column.
   - **No vocabulary impact** (an internal refactor that adds/renames nothing a contributor must
     know) → **no edit.** Not every diff moves a term; an honest no-op is correct.

3. **Apply the minimal edit.** Change only the affected rows. Do not re-sort the whole file, do not
   reformat untouched sections, do not regenerate definitions you didn't need to change — a noisy
   diff buries the one real change and risks clobbering a hand-curated note. Add a new row in its
   section's alphabetical place.

4. **Refresh the dating, lightly.** If the file carries an explicit "last updated" marker, bump it;
   if it relies on git history for its date (source-repository file does), the commit itself is the date —
   don't invent a marker the file doesn't already use.

The result of either mode is a **clean, committed edit to `.glossary/TERMS.md`** and nothing else —
no code change, no issue, no PR (a dispatching repository workflow, when there is one, owns any PR).

---

## Conventions

This skill is one of the portable pipeline suite; its repository-local editing rules and optional
GitHub resolution are stated at their use sites above. The vocabulary spine this skill maintains
is the repo's **4th doc surface** (`.glossary/`), alongside `CLAUDE.md`,
`.decisions/`, and `.patterns/`:

- **One file, terms-only.** `.glossary/TERMS.md` is the whole surface area. Conventions live in
  `CLAUDE.md`/`.patterns/`; architecture vocabulary lives in `.glossary/LANGUAGE.md` (near-frozen,
  not maintained here). Don't widen the skill's reach past TERMS.md.
- **Code is the source of truth.** Every term is derived from what the code does; when the doc and
  the code disagree, fix the doc, never the code.
- **Surgical in incremental mode.** Touch only the rows the change affects; a small diff is the
  point. Wholesale regeneration is the bootstrap exception, not the steady state.
- **No leaked paths.** Cross-references are repo-relative markdown links into `.decisions/` /
  `.patterns/`; never an absolute, home, vault, or Obsidian-wikilink path.
