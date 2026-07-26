# Architecture decisions

This directory records architecture decisions that future contributors need to
understand. Each decision is a Markdown file named `NNNN-short-slug.md`, where
`NNNN` is a four-digit, monotonically increasing identifier.

Every decision starts with this frontmatter:

```yaml
---
id: NNNN
title: <short decision-carrying clause>
status: accepted
date: YYYY-MM-DD
---
```

The body records context, the decision, and its consequences. A superseding
decision links to the prior file and changes that prior file's status. Decision
files are the source of truth; there is no generated index to maintain.

Use `pnpm pipeline cli decisions-index compact` to render an on-demand map,
`pnpm pipeline cli decisions-index next` to allocate the next number from the
current decision set, and `pnpm pipeline cli decisions-index validate` to check
filename, frontmatter, and duplicate-id consistency.

GitHub pull requests may coordinate ADR work when this repository uses them,
but ADR creation and validation do not require GitHub authentication. If this
repository has a PR convention, follow its documented review process; the
portable toolkit does not imply labels, project boards, approval policy, or a
specific GitHub API style.

The repository owns this directory after initialization.
