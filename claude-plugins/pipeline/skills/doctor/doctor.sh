#!/usr/bin/env bash
set -euo pipefail

if [[ ! -x .pipeline/toolkit/bin/pipeline ]]; then
	echo "doctor: .pipeline/toolkit/bin/pipeline is missing; add and initialize the private toolkit submodule first." >&2
	exit 1
fi

exec ./.pipeline/toolkit/bin/pipeline init --check
