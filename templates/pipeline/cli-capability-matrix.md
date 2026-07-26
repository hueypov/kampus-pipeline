# Pipeline CLI capability matrix

This file records which lifecycle and repository safeguards are supplied by the portable core. A listed adapter is intentionally unavailable until the adopting repository supplies its own inputs and activation policy.

| Capability | Status | Boundary |
|---|---|---|
| `main-sync` | Core | Resolves the primary branch from `git.primaryBranch` or `origin/HEAD`; dry-run by default; never resets or force-checks out. |
| `trivial-diff classify` | Core | Fail-closed classifier. It does not select a lighter review gate unless `github.review.trivialDiff.enabled` is explicitly true and a repository-owned router consumes the result. |
| `worktree-sweep` | Core | Inspects only configured managed roots and review prefixes; dry-run by default; never uses force removal. |
| `class-probe` | Deferred shared primitive | The delivery-gate router is the active core implementation. Extract a shared classifier only if a repository can preserve the same routing authority. |
| `catalog-guard`, `guard-content-probe`, `adoption-lint`, `ref-guard` | Repository-convention adapters | Require an adopting repository's dependency, document, corpus, or ref-protection convention. |
| `codeowners-cp`, `control-plane-paths`, `cp-cardinality`, `design-inventory`, `design-token-guard`, provider-specific GitHub helpers, `primary-index-guard`, `ship-digest`, `fanout-guard`, `reachability-guard` | Product or infrastructure adapters | Require a provider, product data model, protected-path policy, design system, or release authority. |

An adapter must declare its configuration, caller, failure behavior, and test fixture before it may be enabled. Do not add a command-shaped stub that silently passes without those repository-owned inputs.
