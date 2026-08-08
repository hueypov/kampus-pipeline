#!/usr/bin/env bash
# Local-toolkit, fail-open dispatch wrapper for the guard hooks.
#
# Usage: guard.sh <tool> [mode...]   e.g. guard.sh worktree-guard pre-file
#                                         guard.sh worktree-guard pre-bash
#                                         guard.sh spawn-guard guard
#                                         guard.sh spawn-guard freshness
#
# The wrapper uses only the adopting repository's `.pipeline/toolkit` submodule.
# A missing or unreadable checkout is an explicit fail-open no-op so hooks never
# abort a Claude session during bootstrap or a partial checkout.

set -u

HOOKS_DIR="$(dirname "${BASH_SOURCE[0]}")"
. "$HOOKS_DIR/resolve-toolkit-root.sh"

TOOLKIT="$(resolve_pipeline_toolkit_root || true)"
PIPELINE="${TOOLKIT:+$TOOLKIT/bin/pipeline}"

# Drain the hook's stdin and exit 0 — the implicit-allow no-op every refusal path takes.
no_dispatch() {
	cat >/dev/null 2>&1 || true
	exit 0
}

if [ -z "$PIPELINE" ] || [ ! -x "$PIPELINE" ]; then no_dispatch; fi

# Pinned build confirmed: dispatch. exec replaces this shell so the CLI owns stdin/stdout
# and its exit code (a real guard verdict — block/allow) is the hook's verdict.
exec "$PIPELINE" cli "$@"
