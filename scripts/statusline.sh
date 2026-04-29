#!/usr/bin/env bash
# statusLine writer for claude-throttle.
#
# Reads the JSON Claude Code pipes on stdin, extracts the rate_limits
# field, and writes it to a cache file that the throttle PreToolUse
# hook reads.
#
# Side-outputs a compact status string for the terminal status bar:
#   "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:32m (n=5)"
# Format per window: "(usage%/window%)" — current utilization /
# elapsed fraction of the billing window. thr:off when CLAUDE_THROTTLE
# is unset/zero/non-numeric. The session block appears only when
# throttling is on and at least one sleep has occurred this session.
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

# Visible status bar text.
echo "$input" | python3 -c '
import json, os, re, sys, time

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

now = time.time()
rl = d.get("rate_limits") or {}

def window_pcts(key, window_s):
    w = rl.get(key) or {}
    used = w.get("used_percentage")
    resets_at = w.get("resets_at")
    if not isinstance(used, (int, float)) or not isinstance(resets_at, (int, float)):
        return None, None
    remaining = resets_at - now
    if remaining < 0 or remaining > window_s:
        elapsed = 0.0
    else:
        elapsed = window_s - remaining
    return used, (elapsed / window_s) * 100.0

fh_usage, fh_window = window_pcts("five_hour", 18000)
sd_usage, sd_window = window_pcts("seven_day", 604800)

throttle_str = (os.environ.get("CLAUDE_THROTTLE") or "").strip()
try:
    thr = float(throttle_str)
except ValueError:
    thr = 0.0

# thr block
thr_part = f"thr:{throttle_str}" if thr > 0 else "thr:off"

# windows block (omit windows with no data)
window_parts = []
if fh_usage is not None:
    window_parts.append(f"5h:({fh_usage:.0f}%/{fh_window:.0f}%)")
if sd_usage is not None:
    window_parts.append(f"7d:({sd_usage:.0f}%/{sd_window:.0f}%)")

# session stats block (only when throttle on AND at least one sleep)
session_part = None
if thr > 0:
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
                session_part = f"session:{dur} (n={count})"
        except (OSError, ValueError):
            pass

segments = [thr_part]
if window_parts:
    segments.append(" ".join(window_parts))
if session_part:
    segments.append(session_part)

print(" | ".join(segments))
'
