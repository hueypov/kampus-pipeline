# Code patterns

This directory records durable, repository-specific descriptions of how the
current code is shaped. Each pattern is a flat Markdown file in this directory;
this index is the routing table for those documents.

Add a pattern document when a recurring implementation shape or invariant would
otherwise need to be rediscovered from code. Ground each document in the current
repository source and link to a decision when the pattern has a recorded why.

| Pattern | Scope | Source |
| --- | --- | --- |
| [The configured control-plane boundary](control-plane-boundary.md) | Protected-change classification, `review-*` / `ship-it` merge authority | `.pipeline/agent-policy.json`, `packages/pipeline-cli/src/tools/protected-change-policy/` |
