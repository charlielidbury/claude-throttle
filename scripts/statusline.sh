#!/usr/bin/env bash
# statusLine writer for claude-throttle.
#
# Reads the JSON Claude Code pipes on stdin, extracts the rate_limits
# field, and writes it to a cache file that the throttle PreToolUse
# hook reads.
#
# Side-outputs a short status string for the terminal status bar:
#   "5h:56% 7d:79%"                    — when CLAUDE_THROTTLE not set
#   "5h:56% 7d:79% | thr:0.9"          — throttle on, no slept-yet
#   "5h:56% 7d:79% | thr:0.9 [12m/3]"  — throttle on, with stats this session
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

# Visible status bar text (rate limits + optional throttle suffix).
echo "$input" | python3 -c '
import json, os, re, sys

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

rl = d.get("rate_limits") or {}
fh = (rl.get("five_hour") or {}).get("used_percentage")
sd = (rl.get("seven_day") or {}).get("used_percentage")

parts = []
if fh is not None: parts.append(f"5h:{fh:.0f}%")
if sd is not None: parts.append(f"7d:{sd:.0f}%")

segments = []
if parts:
    segments.append(" ".join(parts))

# Optional throttle suffix
throttle_str = (os.environ.get("CLAUDE_THROTTLE") or "").strip()
try:
    thr = float(throttle_str)
except ValueError:
    thr = 0.0

if thr > 0:
    suffix = f"thr:{throttle_str}"
    sid = d.get("session_id")
    if isinstance(sid, str):
        sid = re.sub(r"[^a-zA-Z0-9_-]", "", sid)[:80]
    else:
        sid = ""
    if sid:
        stats_dir = os.environ.get("CLAUDE_THROTTLE_STATS_DIR") or "/tmp"
        stats_file = os.path.join(stats_dir, f"claude-throttle-stats-{sid}.json")
        try:
            with open(stats_file) as f:
                stats = json.load(f)
            count = int(stats.get("throttle_count", 0) or 0)
            total = float(stats.get("total_sleep_s", 0) or 0)
            if count > 0:
                if total < 60:
                    dur = f"{int(total)}s"
                elif total < 3600:
                    dur = f"{int(total / 60)}m"
                else:
                    h = int(total // 3600)
                    m = int((total % 3600) // 60)
                    dur = f"{h}h{m}m" if m else f"{h}h"
                suffix = f"thr:{throttle_str} [{dur}/{count}]"
        except (OSError, ValueError):
            pass
    segments.append(suffix)

print(" | ".join(segments))
'
