#!/usr/bin/env bash
# Close a FULLY-graduated map: post the `Graduated into <artifact>` source → artifact provenance
# record and close the source as completed. The `tracker graduate` verb owns that envelope (the
# repository's graduation-close policy) — this script relays it and derives nothing.
#
# usage: graduate-map.sh <map> <artifact> [note]
#
# FULLY-graduated only. A partial graduation is annotated with a plain comment and stays OPEN, so it
# does not come through here.
#
# Shell options are `set -uo pipefail`, deliberately NOT `-e`: this script steers its own control
# flow, and `errexit` would abort a fail-closed branch before it printed its refusal.
set -uo pipefail

[ "$#" -ge 2 ] || {
	echo "wayfinder: graduate-map.sh needs <map> <artifact> — NOTHING was graduated." >&2
	echo "usage: graduate-map.sh <map> <artifact> [note]" >&2
	exit 2
}
MAP="$1"
ARTIFACT="$2"
NOTE="${3:-}"

command -v pipeline-cli >/dev/null 2>&1 || {
	echo "wayfinder: pipeline-cli is not on PATH — NOTHING was graduated." >&2
	exit 127
}

if [ -n "$NOTE" ]; then
	pipeline-cli tracker graduate "$MAP" --artifact "$ARTIFACT" --note "$NOTE"
else
	pipeline-cli tracker graduate "$MAP" --artifact "$ARTIFACT"
fi
