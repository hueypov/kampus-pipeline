# Repository guidance

This file is the repository-owned entry point for contributor and agent guidance.
Keep it focused on instructions that apply across the repository, such as local
validation, ownership boundaries, and the sources that ground technical claims.

## Local validation

- `pnpm -r typecheck` — all three workspace packages.
- `pnpm -r --workspace-concurrency=1 test` — keep the concurrency cap: the
  `pipeline` package's init suite shells out to real `git` and `pnpm` per
  fixture and misses its per-test timeout when run beside the other suites.
- `pnpm --filter pipeline check:workflow-catalog` — the catalogue is generated
  from the workflow templates; regenerate with `generate:workflow-catalog` in
  the same commit that changes them.

## Documentation surfaces

- `.decisions/` records architecture decisions and their history.
- `.patterns/` records durable descriptions of how the current code is shaped.
- `.glossary/TERMS.md` records the repository's domain vocabulary.
- `.glossary/LANGUAGE.md` records the shared architecture vocabulary.

The repository owns these documents after initialization. Update them when the
repository's own conventions, decisions, patterns, or vocabulary change.
