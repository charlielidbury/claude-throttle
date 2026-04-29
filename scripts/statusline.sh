#!/usr/bin/env bash
# statusLine writer for claude-throttle.
#
# Reads the JSON Claude Code pipes on stdin, extracts the rate_limits
# field, and writes it to a cache file that the throttle PreToolUse
# hook reads.
#
# Side-outputs a short status string for the terminal status bar so the
# user can see current utilization at a glance.
set -u

CACHE_FILE="${CLAUDE_THROTTLE_CACHE:-/tmp/claude-throttle-cache.json}"
input=$(cat)

# Atomic cache write: write to .tmp, then mv. Avoids the throttle hook
# reading a half-written file mid-update.
tmp="${CACHE_FILE}.tmp.$$"
echo "$input" | python3 -c "
import json, sys, time
d = json.load(sys.stdin)
out = {
    'captured_at': int(time.time()),
    'rate_limits': d.get('rate_limits'),  # may be null until first API response
}
print(json.dumps(out))
" > "$tmp" 2>/dev/null && mv "$tmp" "$CACHE_FILE" || rm -f "$tmp"

# Visible status bar text
echo "$input" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    rl = d.get('rate_limits') or {}
    fh = (rl.get('five_hour') or {}).get('used_percentage')
    sd = (rl.get('seven_day') or {}).get('used_percentage')
    parts = []
    if fh is not None: parts.append(f'5h:{fh:.0f}%')
    if sd is not None: parts.append(f'7d:{sd:.0f}%')
    print(' '.join(parts) if parts else '')
except Exception:
    pass
"
