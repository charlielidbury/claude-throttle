#!/usr/bin/env bash
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
