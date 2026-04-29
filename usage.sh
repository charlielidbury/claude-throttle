#!/usr/bin/env bash
#
# Hits the same internal endpoint that powers Claude Code's /usage
# slash command. Discovered by reverse-engineering the Claude Code
# binary; the endpoint is not publicly documented.
#
# NOT used by the throttle itself — the throttle reads rate-limit
# data from the statusLine payload instead (officially documented,
# no reverse engineering). This script is kept around as an ad-hoc
# debug helper: handy for sanity-checking what the server thinks
# your utilization is, independent of the cache layer.
#
# See docs/rejected-endpoint-approach.md for why we didn't build the
# throttle on top of this.
set -euo pipefail

CRED_FILE="${CLAUDE_CREDENTIALS:-$HOME/.claude/.credentials.json}"

if [[ ! -r "$CRED_FILE" ]]; then
  echo "error: cannot read $CRED_FILE" >&2
  exit 1
fi

TOKEN=$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['claudeAiOauth']['accessToken'])" "$CRED_FILE")

curl -sS --fail-with-body \
  -H "Authorization: Bearer $TOKEN" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "Content-Type: application/json" \
  https://api.anthropic.com/api/oauth/usage
