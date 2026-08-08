---
name: author-skill
description: "The authoring-side guide for writing a new repository skill — the complement to the review-skill gate. Read it before you write a `skills/**/SKILL.md`. It covers the SKILL.md shape (frontmatter name/description contract, prose-first body), the house rules adopted by the repository (tooling follows host conventions, no unnecessary `sources/` tree, no second validator when review-skill already gates), how to author toward review-skill's four rigor checks so the gate passes on the first pass, the gate-skill house-style exemption, and the protected-path destination re-check. Trigger on \"author a new skill\", \"write a skill\", \"how do I add a skill\", \"what shape should this SKILL.md be\", \"run author-skill\", or whenever you are about to create or substantially rewrite a `skills/**` skill and need the repository conventions. This is a reference guide, not a pipeline stage: it never picks issues, opens PRs, or merges — write-code does the building, review-skill does the gating, this tells you how to write the artifact in between."
---

# author-skill

## Repository-owned policy boundary

This guide is part of the default generic payload and `pipeline init` links it into
`.claude/skills`. It is local guidance, not authority to create issues, branches, pull
requests, labels, or releases. When the resulting skill change enters a repository workflow,
follow that repository's contributor guidance and `.pipeline/agent-policy.json`.

You are about to write a **repository skill** — a `SKILL.md` under `skills/**` that an agent
loads and follows as a procedure. This guide is the authoring-side complement to
[`review-skill`](../review-skill/SKILL.md): review-skill *gates* a skill PR against its
issue's acceptance criteria plus four rigor checks; this tells you how to write the skill so
it passes that gate on the first pass, in the house idiom. Read it before you create or
substantially rewrite a `SKILL.md`.

This is a **guide, not a pipeline stage**. It picks no issues, opens no PRs, merges nothing —
`write-code` builds, `review-skill` gates, and this is the shape you write in between.

## What a repository skill is

A skill is a single `skills/<name>/SKILL.md` file: **YAML frontmatter** (`name` +
`description`) followed by a **prose body** the agent follows as instructions. That is the
whole artifact. There is no manifest to register it in, no code scaffold, no build step —
the harness discovers skills by scanning `skills/*/SKILL.md` and routes on the frontmatter
`description`.

A skill is neither product code nor prose: it
is a **behavioral artifact**, the executable instruction an agent runs. Write it as
instructions to that future agent — imperative, specific, and self-contained — not as an
essay describing what the skill would do.

## The house rules (from the writing-craft manifest)

The `skill-authoring` idea was imported from
[joshuadavidthomas/agent-skills](https://github.com/joshuadavidthomas/agent-skills) and
adapted to the repository's own conventions. The adaptation avoids unnecessary tooling, so a
repository skill carries **none** of these unless the host repository explicitly requires them:

- **No imposed implementation language.** A skill that needs deterministic support uses the
  host repository's existing tooling and validation conventions. It does not introduce a new
  runtime, package manager, or scripting language merely because another repository used one.
- **No `sources/` tree.** The upstream skill vendored a reference corpus under `sources/`.
  Repository skills normally do not — a skill is one `SKILL.md`. If you need supporting material,
  link out to the authoritative repository document rather than vendoring a stale copy.
- **No second validator.** Do not re-implement what `review-skill` already gates. The gate
  reads your diff and checks behavioral correctness, trigger quality, cross-skill shadowing,
  and gate-invariant preservation (below). Authoring a parallel skill-linting validator
  duplicates that gate and drifts from it; the frontmatter floor is already enforced by
  [`validate-skills.sh`](../validate-skills.sh) in CI.

Lean by default: a skill states what it is and the one non-obvious thing, and instructs the
agent — it does not re-derive an ADR's rationale it can point to. The exception is below.

## The frontmatter contract (CI-enforced)

[`validate-skills.sh`](../validate-skills.sh) fails the build unless every
`skills/*/SKILL.md`:

1. Opens with a `---` frontmatter fence on **line 1**.
2. Carries a non-empty `name` that **matches the directory** (`skills/author-skill/` →
   `name: author-skill`).
3. Carries a non-empty `description`.

The `description` is not a summary — **it is the routing surface the harness fires on**. A
malformed or vague one makes the skill silently unroutable. Write it as concrete trigger
conditions: what the skill is, then the phrases and situations it should fire on. This is
also rigor check #2 (below), so getting it right here is getting it right for the gate.

## Author toward review-skill's four rigor checks

review-skill verifies your PR against its issue's acceptance criteria **and** four rigor
checks, conjunctively — any one failing fails the gate. Write to satisfy all four up front:

1. **Behavioral correctness.** Does the instruction *produce the intended behavior* when an
   agent follows it literally? Write concrete, ordered steps a fresh agent can execute
   without inferring your intent. Ambiguity that "obviously" means one thing to you is where
   this check fails.
2. **Trigger / `description` quality.** The skill must fire when it should and **not**
   otherwise. Too broad and it shadows a sibling (fires on prompts meant for another lane);
   too narrow and it never triggers. State the specific situations, and confirm the trigger
   surface doesn't overlap an existing skill's `description`.
3. **Cross-skill conflict / shadowing.** Read the sibling skills before you write. Your skill
   must not collide with or mask another's lane, duplicate its job under a new name, or
   instruct an action that contradicts an adjacent skill. A new skill earns its own lane or
   extends an existing one — it does not overlap.
4. **Gate-invariant preservation.** If your edit touches a gate skill (a review-*, ship-it,
   write-code, plan-epic, triage, or release skill), it must not *quietly weaken a gate* —
   drop a SHA binding, remove a fail-closed assertion, loosen a denylist. This is the most
   serious verdict the gate lands; if you are editing a gate skill, name the invariant you
   are preserving and prove the edit keeps it.

## The gate-skill house-style exemption

The lean/Strunk prose doctrine and the "comments earn their place" austerity **do not apply
to the gate skills** (the review-* / ship-it / write-code / plan-epic / triage / release
skills). Those are long, incident-hardened instruction surfaces: they carry embedded ADR
rationale, incident-number pointers, and fail-closed ceremony *on purpose*, because a dropped
invariant there is a security or correctness hole (the trust-inversion and false-PASS classes
those skills were hardened against). Their prose weight is load-bearing.

So: when you author a **new, non-gate** skill, keep it lean. When you edit a **gate** skill,
match its existing register — do not "deslop" its invariant prose, do not compress a
fail-closed rationale to a one-liner, do not trim an incident pointer that anchors a guard.
The rigor check #4 above is the enforcement; this exemption is why the prose looks heavy.

## Destination and protected paths — re-check before you open the PR

Where a skill lives may decide whether its PR is protected or auto-shippable. **Re-check the
final path** against the repository's live protected-path policy before opening the PR:

```bash
# Run the repository's documented protected-path or ownership check, when one exists.
```

The repository's policy may protect gate skills, executable helpers, automation configuration,
CI workflows, or other high-impact paths. A new non-gate `SKILL.md` may be eligible for normal
delivery, but do not assume that outcome from this guide: confirm the destination against the
live repository policy, which is the authoritative source.

## When you're done

Run the repository's available skill validation locally. If your skill is a **pipeline stage** (a named
step in the report → triage → … → ship-it flow), add a one-line row to the skills table in
the plugin [`README.md`](../../README.md); an **ambient** skill (a guide or standalone tool,
like this one) is discovered by the harness's `skills/*/SKILL.md` scan and needs no README
row. Then hand the PR to `review-skill` — it gates the four rigor checks above; you do not
review your own skill.
