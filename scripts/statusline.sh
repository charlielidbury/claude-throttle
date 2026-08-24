#!/usr/bin/env bash
# statusLine writer for claude-throttle.
#
# Reads the JSON Claude Code pipes on stdin, extracts the rate_limits
# field, and writes it to a cache file that the throttle PreToolUse
# hook reads.
#
# Side-outputs a compact status string for the terminal status bar:
#   "thr:0.7 | 5h:(56%/80%) 7d:(79%,90%/92%) | 213k (21%) | session:32m (n=5)"
# Format per window: "(usage%/window%)" — current utilization /
# elapsed fraction of the billing window. The 7-day block carries a
# second usage number when the Fable weekly limit is known
# ("(all-models%,fable%/window%)"); see fable-usage.py for where that
# comes from. thr:off when CLAUDE_THROTTLE is unset/zero/non-numeric.
# The context block is the live context window occupancy
# ("<tokens> (<pct of window>%)"), from the context_window field Claude
# Code pipes in; it is absent until the first API response. The session
# block appears only when throttling is on and at least one sleep has
# occurred this session.
set -u

CACHE_FILE="${CLAUDE_THROTTLE_CACHE:-/tmp/claude-throttle-cache.json}"
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
# Background refresher for the Fable weekly percentage (see below).
export CLAUDE_THROTTLE_FABLE_FETCHER="${CLAUDE_THROTTLE_FABLE_FETCHER:-$SCRIPT_DIR/fable-usage.py}"
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
import hashlib, json, os, re, subprocess, sys, time

try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)

now = time.time()
rl = d.get("rate_limits") or {}


def env_float(name, default):
    try:
        return float(os.environ.get(name) or "")
    except ValueError:
        return default


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


# --- Fable weekly window ---------------------------------------------
# Claude Code does not pipe this one: rate_limits is built from the
# unified rate-limit response headers, which carry no per-model bucket.
# scripts/fable-usage.py fetches it from the usage endpoint in the
# background and leaves it in a cache file; here we only read that cache,
# so the status bar never waits on the network. If a future Claude Code
# starts sending model_scoped entries, those win and the cache is unused.
def model_scoped_pct(name):
    entries = rl.get("model_scoped")
    if not isinstance(entries, list):
        return None
    for e in entries:
        if not isinstance(e, dict):
            continue
        dn = e.get("display_name")
        if not isinstance(dn, str) or dn.strip().lower() != name:
            continue
        u = e.get("utilization")
        if isinstance(u, (int, float)) and not isinstance(u, bool):
            return float(u)
    return None


def spawn_fable_refresh():
    fetcher = os.environ.get("CLAUDE_THROTTLE_FABLE_FETCHER") or ""
    if not fetcher or not os.path.exists(fetcher):
        return
    try:
        subprocess.Popen(
            [sys.executable, fetcher],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    except OSError:
        pass


def cached_fable_pct():
    cred = os.environ.get("CLAUDE_CREDENTIALS")
    if not cred:
        base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
            os.path.expanduser("~"), ".claude"
        )
        cred = os.path.join(base, ".credentials.json")
    try:
        with open(cred) as f:
            token = (json.load(f).get("claudeAiOauth") or {}).get("accessToken")
    except (OSError, ValueError, AttributeError):
        return None  # no credentials to fetch with (keychain, API key, ...)
    if not isinstance(token, str) or not token:
        return None
    # Tie the cached number to the token that produced it: after an
    # account switch the old number is hidden rather than shown as if it
    # belonged to the new account.
    fp = hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]

    path = (
        os.environ.get("CLAUDE_THROTTLE_FABLE_CACHE")
        or "/tmp/claude-throttle-fable.json"
    )
    try:
        with open(path) as f:
            c = json.load(f)
    except (OSError, ValueError):
        c = {}
    if not isinstance(c, dict) or c.get("token_fp") != fp:
        c = {}

    attempted = c.get("attempted_at")
    ttl = env_float("CLAUDE_THROTTLE_FABLE_TTL", 300.0)
    if not isinstance(attempted, (int, float)) or now - attempted >= ttl:
        spawn_fable_refresh()

    fetched = c.get("fetched_at")
    pct = c.get("fable_pct")
    max_age = env_float("CLAUDE_THROTTLE_FABLE_MAX_AGE", 900.0)
    if not isinstance(fetched, (int, float)) or now - fetched > max_age:
        return None  # never fetched, or too stale to be worth showing
    if not isinstance(pct, (int, float)) or isinstance(pct, bool):
        return None  # account has no Fable bucket
    return float(pct)


def fable_pct():
    if (os.environ.get("CLAUDE_THROTTLE_FABLE") or "").strip().lower() in (
        "0",
        "off",
        "false",
        "no",
    ):
        return None
    live = model_scoped_pct("fable")
    return live if live is not None else cached_fable_pct()


fb_usage = fable_pct()

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
    if fb_usage is not None:
        window_parts.append(
            f"7d:({sd_usage:.0f}%,{fb_usage:.0f}%/{sd_window:.0f}%)"
        )
    else:
        window_parts.append(f"7d:({sd_usage:.0f}%/{sd_window:.0f}%)")

# context window block (absent until the first API response)
cw = d.get("context_window") or {}
usage = cw.get("current_usage") or {}

def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

ctx_tokens = None
if usage:
    ctx_tokens = (
        num(usage.get("input_tokens"))
        + num(usage.get("cache_creation_input_tokens"))
        + num(usage.get("cache_read_input_tokens"))
    )

ctx_pct = cw.get("used_percentage")
if not isinstance(ctx_pct, (int, float)) or isinstance(ctx_pct, bool):
    ctx_pct = None
size = cw.get("context_window_size")
if ctx_pct is None and ctx_tokens is not None and isinstance(size, (int, float)) and size > 0:
    ctx_pct = min(100.0, max(0.0, (ctx_tokens / size) * 100.0))

context_part = None
if ctx_tokens is not None:
    tok = f"{ctx_tokens / 1000:.0f}k" if ctx_tokens >= 1000 else f"{ctx_tokens:.0f}"
    context_part = f"{tok} ({ctx_pct:.0f}%)" if ctx_pct is not None else tok

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
if context_part:
    segments.append(context_part)
if session_part:
    segments.append(session_part)

print(" | ".join(segments))
'
