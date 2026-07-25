#!/usr/bin/env bash

# Project-local pipeline installs always resolve the toolkit from the adopting
# repository's pinned submodule. Hooks must never look for an npm-installed CLI.
resolve_pipeline_toolkit_root() {
	local root="${CLAUDE_PROJECT_DIR:-}"
	if [ -z "$root" ] || [[ "$root" == *'${'* ]]; then
		return 1
	fi
	local toolkit="$root/.pipeline/toolkit"
	if [ ! -x "$toolkit/bin/pipeline" ]; then
		return 1
	fi
	printf '%s' "$toolkit"
}
