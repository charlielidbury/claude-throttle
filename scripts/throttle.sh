#!/usr/bin/env bash
# claude-throttle PreToolUse hook.
#
# Reads the cache file written by statusline.sh, computes whether the
# current rate-limit utilization is ahead of the linear-pacing target,
# and sleeps before allowing the tool call if so.
#
# After a non-zero sleep, increments a per-session stats file at
# ${CLAUDE_THROTTLE_STATS_DIR:-/tmp}/claude-throttle-stats-<session_id>.json
# so statusline.sh can surface a summary in the status bar.
#
# Activation: set CLAUDE_THROTTLE to a positive number in (0, 1].
# Unset, empty, zero, or non-numeric values disable the hook (exit 0).
set -u

throttle="${CLAUDE_THROTTLE:-}"
if [[ -z "$throttle" ]]; then
  exit 0
fi
if ! python3 -c 'import sys; v=float(sys.argv[1]); sys.exit(0 if v > 0 else 1)' "$throttle" 2>/dev/null; then
  exit 0
fi

# Read the PreToolUse JSON event so we can extract session_id for the
# per-session stats file. Pacing math doesn't need it; if parsing fails,
# session_id stays empty and stats writes are silently skipped.
input=$(cat 2>/dev/null) || input=""
session_id=$(printf '%s' "$input" | python3 -c '
import json, re, sys
try:
    d = json.loads(sys.stdin.read())
    sid = d.get("session_id")
    if isinstance(sid, str):
        sid = re.sub(r"[^a-zA-Z0-9_-]", "", sid)[:80]
    else:
        sid = ""
    print(sid)
except Exception:
    print("")
' 2>/dev/null) || session_id=""

MAX_SLEEP="${MAX_SLEEP:-540}"
WARMUP_THRESHOLD_PCT="${WARMUP_THRESHOLD_PCT:-10}"
MAX_CACHE_AGE_S="${MAX_CACHE_AGE_S:-300}"
THROTTLE_LOG="${THROTTLE_LOG:-$HOME/.claude/throttle.log}"
CACHE_FILE="${CLAUDE_THROTTLE_CACHE:-/tmp/claude-throttle-cache.json}"
STATS_DIR="${CLAUDE_THROTTLE_STATS_DIR:-/tmp}"

log_msg() {
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null) || ts="?"
  mkdir -p "$(dirname "$THROTTLE_LOG")" 2>/dev/null || true
  printf '%s %s\n' "$ts" "$1" >> "$THROTTLE_LOG" 2>/dev/null || true
}

if [[ ! -f "$CACHE_FILE" ]]; then
  log_msg "skip: no cache file at $CACHE_FILE"
  exit 0
fi

# All pacing math runs in python. Emits a single JSON line:
#   {"kind":"skip","reason":...}
#   {"kind":"sleep","sleep_s":N,"log":"...","systemMessage":"..."}
result=$(python3 - "$CACHE_FILE" "$throttle" "$MAX_SLEEP" "$WARMUP_THRESHOLD_PCT" "$MAX_CACHE_AGE_S" <<'PYEOF' 2>/dev/null
import json, sys, time

cache_path = sys.argv[1]
throttle = float(sys.argv[2])
max_sleep = float(sys.argv[3])
warmup = float(sys.argv[4])
max_age = float(sys.argv[5])

now = time.time()
WINDOWS = [
    ('five_hour', 18000, '5h'),
    ('seven_day', 604800, '7d'),
]

def emit(d):
    print(json.dumps(d, separators=(',', ':')))
    sys.exit(0)

try:
    with open(cache_path) as f:
        data = json.load(f)
except Exception as e:
    emit({'kind': 'skip', 'reason': f'invalid cache JSON: {type(e).__name__}: {e}'})

if not isinstance(data, dict):
    emit({'kind': 'skip', 'reason': 'cache root is not an object'})

captured_at = data.get('captured_at')
if not isinstance(captured_at, (int, float)):
    emit({'kind': 'skip', 'reason': 'cache missing or invalid captured_at'})

age = now - captured_at
if age > max_age:
    emit({'kind': 'skip', 'reason': f'stale cache (age={age:.0f}s > max={max_age:.0f}s)'})

rl = data.get('rate_limits')
if rl is None:
    emit({'kind': 'skip', 'reason': 'no rate_limits in cache (cold start)'})
if not isinstance(rl, dict):
    emit({'kind': 'skip', 'reason': 'rate_limits is not an object'})

infos = []
sleeps = []  # (sleep_s, label, used_pct, elapsed_pct)
for key, window_s, label in WINDOWS:
    w = rl.get(key)
    if not isinstance(w, dict):
        infos.append(f'{label}=absent')
        continue
    used_pct = w.get('used_percentage')
    resets_at = w.get('resets_at')
    if not isinstance(used_pct, (int, float)) or not isinstance(resets_at, (int, float)):
        infos.append(f'{label}=incomplete')
        continue

    remaining = resets_at - now
    if remaining < 0 or remaining > window_s:
        elapsed_s = 0.0
    else:
        elapsed_s = window_s - remaining
    elapsed_pct = (elapsed_s / window_s) * 100.0

    if used_pct < warmup:
        infos.append(f'{label}={used_pct:.1f}%@{elapsed_pct:.0f}%(warmup)')
        continue

    util_frac = used_pct / 100.0
    target_elapsed = util_frac * window_s / throttle
    sleep_w = max(0.0, target_elapsed - elapsed_s)
    sleeps.append((sleep_w, label, used_pct, elapsed_pct))
    infos.append(f'{label}={used_pct:.1f}%@{elapsed_pct:.0f}%(s={sleep_w:.0f}s)')

if not sleeps:
    emit({'kind': 'skip', 'reason': 'no eligible windows: ' + ' '.join(infos)})

best = max(sleeps, key=lambda x: x[0])
final_sleep = min(best[0], max_sleep)

if final_sleep <= 0:
    emit({'kind': 'skip', 'reason': 'on or behind pace: ' + ' '.join(infos)})

parts = [f'{lbl}: {up:.0f}% util at {ep:.0f}% elapsed' for _, lbl, up, ep in sleeps]
sysmsg = f'Throttle: slept {final_sleep:.0f}s ({"; ".join(parts)}; throttle={throttle})'

emit({
    'kind': 'sleep',
    'sleep_s': final_sleep,
    'log': f'sleep={final_sleep:.0f}s ' + ' '.join(infos),
    'systemMessage': sysmsg,
})
PYEOF
)

if [[ -z "$result" ]]; then
  log_msg "error: pacing computation produced no output"
  exit 0
fi

kind=$(printf '%s' "$result" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("kind",""))
except: print("")' 2>/dev/null) || kind=""

case "$kind" in
  skip)
    reason=$(printf '%s' "$result" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("reason",""))
except: print("")' 2>/dev/null)
    log_msg "skip: $reason"
    ;;
  sleep)
    sleep_s=$(printf '%s' "$result" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("sleep_s",0))
except: print(0)' 2>/dev/null)
    log_summary=$(printf '%s' "$result" | python3 -c 'import json,sys
try: print(json.loads(sys.stdin.read()).get("log",""))
except: print("")' 2>/dev/null)
    log_msg "sleep: $log_summary"
    sleep "$sleep_s" || true
    printf '%s' "$result" | python3 -c 'import json,sys
try:
    d = json.loads(sys.stdin.read())
    print(json.dumps({"systemMessage": d["systemMessage"]}))
except:
    pass' 2>/dev/null || true

    # Update per-session stats file (best-effort; missing session_id = skip silently)
    if [[ -n "$session_id" ]]; then
      stats_file="$STATS_DIR/claude-throttle-stats-$session_id.json"
      mkdir -p "$STATS_DIR" 2>/dev/null || true
      python3 - "$stats_file" "$sleep_s" <<'STATS_PY' 2>/dev/null || true
import json, os, sys, time
stats_file = sys.argv[1]
slept = float(sys.argv[2])

try:
    with open(stats_file) as f:
        stats = json.load(f)
    if not isinstance(stats, dict):
        stats = {}
except Exception:
    stats = {}

stats['total_sleep_s'] = float(stats.get('total_sleep_s', 0) or 0) + slept
stats['throttle_count'] = int(stats.get('throttle_count', 0) or 0) + 1
stats['last_sleep_at'] = int(time.time())

tmp = stats_file + f'.tmp.{os.getpid()}'
with open(tmp, 'w') as f:
    json.dump(stats, f)
os.replace(tmp, stats_file)
STATS_PY
    fi
    ;;
  *)
    log_msg "error: unrecognized pacing output: $result"
    ;;
esac

exit 0
