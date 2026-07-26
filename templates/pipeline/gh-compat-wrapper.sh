#!/usr/bin/env sh
# Optional repository-local gh wrapper. It is deliberately not installed on PATH by pipeline init.
# Enable github.cliCompatibility and arrange for this wrapper's directory to precede the real gh
# only in the agent/session environment that requires a repository-specific compatibility rule.
set -eu

: "${CLAUDE_PROJECT_DIR:?gh-compat wrapper requires CLAUDE_PROJECT_DIR}"
exec node "$CLAUDE_PROJECT_DIR/.pipeline/toolkit/packages/pipeline-cli/dist/tools/gh-compat/shim-bin.js" "$@"
