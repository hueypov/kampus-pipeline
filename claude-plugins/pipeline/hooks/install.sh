#!/usr/bin/env bash
# SessionStart: verify the adopting repository's pinned private toolkit. This
# intentionally performs no network or registry install.

set -u

HOOKS_DIR="$(dirname "${BASH_SOURCE[0]}")"
. "$HOOKS_DIR/resolve-toolkit-root.sh"

TOOLKIT="$(resolve_pipeline_toolkit_root || true)"
if [ -z "$TOOLKIT" ]; then
	echo "pipeline: private toolkit is unavailable at .pipeline/toolkit; guards fail open" >&2
	exit 0
fi

if "$TOOLKIT/bin/pipeline" cli version >/dev/null 2>&1; then
	exit 0
fi

echo "pipeline: local toolkit failed its CLI readiness check; guards fail open" >&2
exit 0
