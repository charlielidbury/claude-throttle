#!/usr/bin/env bash
# Unit tests for scripts/statusline.sh.
#
# Verifies the visible status bar text under various conditions:
# - With/without rate_limits in input
# - With CLAUDE_THROTTLE unset/empty/zero/positive
# - With/without per-session stats file
# - With one or both windows present
# - With/without the context_window block
# - With/without a cached Fable weekly percentage
set -u

REPO_ROOT="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"
STATUSLINE_SH="$REPO_ROOT/scripts/statusline.sh"

if [[ ! -x "$STATUSLINE_SH" ]]; then
  echo "ERROR: $STATUSLINE_SH not found or not executable" >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CACHE_FILE="$WORK/cache.json"
STATS_DIR="$WORK/stats"
mkdir -p "$STATS_DIR"

FABLE_CACHE="$WORK/fable.json"
CRED_FILE="$WORK/credentials.json"
SPAWN_LOG="$WORK/fable-spawn.log"
STUB_FETCHER="$WORK/stub-fetcher.py"
# Overrides the credentials file for a single test (empty = the fake one).
CREDS=""

# Fake credentials. The statusline only reads the access token, which it
# hashes to tie a cached Fable percentage to one account.
python3 -c '
import json, sys
with open(sys.argv[1], "w") as f:
    json.dump({"claudeAiOauth": {"accessToken": "token-A", "expiresAt": 9999999999000}}, f)
' "$CRED_FILE"

# Stand-in for scripts/fable-usage.py: records that it was spawned rather
# than going near the network.
cat > "$STUB_FETCHER" <<'PYEOF'
import os
with open(os.environ["FABLE_SPAWN_LOG"], "a") as f:
    f.write("spawned\n")
PYEOF

TESTS_RUN=0
TESTS_FAILED=0
FAILED_NAMES=()

# Build a JSON input with relative resets_at timestamps so the elapsed
# percentages are stable regardless of when tests run.
#
#   $1 fh_used_pct  number, "absent", or "incomplete" (no resets_at)
#   $2 fh_remaining seconds until reset; special value "null" → resets_at: null
#   $3 sd_used_pct  number, "absent", or "incomplete"
#   $4 sd_remaining seconds until reset, or "null"
#   $5 with_session_id  "yes" or "no"
#
# 18000s window: window % = (18000-remaining)/18000*100
# 604800s window: window % = (604800-remaining)/604800*100
make_input() {
  python3 -c '
import json, sys, time
fh_pct, fh_rem, sd_pct, sd_rem, with_sid = sys.argv[1:6]
now = time.time()
rl = {}
if fh_pct != "absent":
    fh = {}
    if fh_pct != "incomplete":
        fh["used_percentage"] = float(fh_pct)
    fh["resets_at"] = None if fh_rem == "null" else now + float(fh_rem)
    rl["five_hour"] = fh
if sd_pct != "absent":
    sd = {}
    if sd_pct != "incomplete":
        sd["used_percentage"] = float(sd_pct)
    sd["resets_at"] = None if sd_rem == "null" else now + float(sd_rem)
    rl["seven_day"] = sd

payload = {"rate_limits": rl if rl else None}
if with_sid == "yes":
    payload["session_id"] = "sess-A"
print(json.dumps(payload))
' "$@"
}

# Splice a context_window block into an existing input JSON.
#
#   $1 input_json
#   $2 in-context tokens, or "none" for a null current_usage (cold start),
#      or "absent" to omit context_window entirely
#   $3 context_window_size
#   $4 used_percentage, or "null" to force the fallback computation
add_context() {
  python3 -c '
import json, sys
payload = json.loads(sys.argv[1])
tokens, size, pct = sys.argv[2:5]
if tokens != "absent":
    cw = {"context_window_size": int(size)}
    if tokens == "none":
        cw["current_usage"] = None
        cw["used_percentage"] = None
    else:
        # Split across the three fields the statusline must sum.
        t = int(tokens)
        cw["current_usage"] = {
            "input_tokens": t - (t // 2) - (t // 4),
            "output_tokens": 50,
            "cache_creation_input_tokens": t // 4,
            "cache_read_input_tokens": t // 2,
        }
        cw["used_percentage"] = None if pct == "null" else float(pct)
    payload["context_window"] = cw
print(json.dumps(payload))
' "$@"
}

# Splice a model_scoped array into an existing input JSON. Claude Code
# does not send one today; this covers the day it starts.
#
#   $1 input_json  $2 display_name  $3 utilization
add_model_scoped() {
  python3 -c '
import json, sys
payload = json.loads(sys.argv[1])
rl = payload.get("rate_limits") or {}
rl["model_scoped"] = [
    {"display_name": sys.argv[2], "utilization": float(sys.argv[3]), "resets_at": None}
]
payload["rate_limits"] = rl
print(json.dumps(payload))
' "$@"
}

# Write the cache scripts/fable-usage.py would have written.
#
#   $1 fable_pct     number, or "null" (account with no Fable bucket)
#   $2 fetched_age   seconds since the last successful fetch
#   $3 attempted_age seconds since the last fetch attempt
#   $4 token         account the cache belongs to (default token-A)
write_fable_cache() {
  python3 -c '
import hashlib, json, sys, time
path, pct, fetched_age, attempted_age, token = sys.argv[1:6]
now = time.time()
entry = {
    "attempted_at": now - float(attempted_age),
    "fetched_at": now - float(fetched_age),
    "fable_pct": None if pct == "null" else float(pct),
    "token_fp": hashlib.sha256(token.encode("utf-8")).hexdigest()[:16],
}
with open(path, "w") as f:
    json.dump(entry, f)
' "$FABLE_CACHE" "$1" "$2" "$3" "${4:-token-A}"
}

write_stats() {
  local sid="$1" count="$2" total_s="$3"
  python3 -c '
import json, sys
file = sys.argv[1]
count = int(sys.argv[2])
total = float(sys.argv[3])
with open(file, "w") as f:
    json.dump({"throttle_count": count, "total_sleep_s": total, "last_sleep_at": 0}, f)
' "$STATS_DIR/claude-throttle-stats-$sid.json" "$count" "$total_s"
}

# Stable inputs:
# 5h window @ 80% elapsed (3600s remaining of 18000)
# 7d window @ 92% elapsed (50400s remaining of 604800)
INPUT_FULL=$(make_input 56 3600 79 50400 yes)
INPUT_COLD='{"session_id":"sess-A","rate_limits":null}'
INPUT_ONLY_5H=$(make_input 56 3600 absent 0 yes)
INPUT_ONLY_7D=$(make_input absent 0 79 50400 yes)
INPUT_NO_SID=$(make_input 56 3600 79 50400 no)

LAST_STDOUT=""
run_statusline() {
  local input_json="$1"
  local throttle_val="${2:-}"
  local fable_val="${3:-}"
  LAST_STDOUT=$(
    CLAUDE_THROTTLE="$throttle_val" \
    CLAUDE_THROTTLE_CACHE="$CACHE_FILE" \
    CLAUDE_THROTTLE_STATS_DIR="$STATS_DIR" \
    CLAUDE_THROTTLE_FABLE="$fable_val" \
    CLAUDE_THROTTLE_FABLE_CACHE="$FABLE_CACHE" \
    CLAUDE_THROTTLE_FABLE_FETCHER="$STUB_FETCHER" \
    CLAUDE_CREDENTIALS="${CREDS:-$CRED_FILE}" \
    FABLE_SPAWN_LOG="$SPAWN_LOG" \
    "$STATUSLINE_SH" <<<"$input_json" 2>/dev/null
  )
}

assert_stdout_eq() {
  local want="$1"
  if [[ "$LAST_STDOUT" != "$want" ]]; then
    echo "  FAIL: stdout mismatch"
    echo "    want: $want"
    echo "    got:  $LAST_STDOUT"
    return 1
  fi
}

run() {
  local name="$1"; shift
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "TEST: $name"
  if ! "$@"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
}

clear_stats() { rm -f "$STATS_DIR"/*.json; }

# The Fable refresh is detached, so a spawn from the previous test can
# still be in flight — drain before clearing.
clear_fable() { sleep 0.1; rm -f "$FABLE_CACHE" "$SPAWN_LOG"; }

assert_spawned() {
  local i
  for i in $(seq 20); do
    [[ -s "$SPAWN_LOG" ]] && return 0
    sleep 0.1
  done
  echo "  FAIL: expected a background Fable refresh, none ran"
  return 1
}

assert_not_spawned() {
  sleep 0.3   # long enough that a spawn would have landed
  if [[ -s "$SPAWN_LOG" ]]; then
    echo "  FAIL: unexpected background Fable refresh"
    return 1
  fi
}

# --- test cases ---

test_throttle_off() {
  clear_stats
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_zero() {
  clear_stats
  run_statusline "$INPUT_FULL" "0"
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_garbage() {
  clear_stats
  run_statusline "$INPUT_FULL" "foo"
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_negative() {
  clear_stats
  run_statusline "$INPUT_FULL" "-0.5"
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_on_no_stats() {
  clear_stats
  run_statusline "$INPUT_FULL" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_multiplier_verbatim() {
  clear_stats
  # Verifies the user-supplied form is preserved (e.g. "0.50" stays "0.50").
  run_statusline "$INPUT_FULL" "0.50"
  assert_stdout_eq "thr:0.50 | 5h:(56%/80%) 7d:(79%/92%)"
}

test_session_minutes() {
  clear_stats
  write_stats "sess-A" 5 1920   # 32m, 5 events
  run_statusline "$INPUT_FULL" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:32m (n=5)"
}

test_session_seconds() {
  clear_stats
  write_stats "sess-A" 1 45     # 45s, 1 event
  run_statusline "$INPUT_FULL" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:45s (n=1)"
}

test_session_hours_minutes() {
  clear_stats
  write_stats "sess-A" 5 3725   # 1h2m, 5 events
  run_statusline "$INPUT_FULL" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:1h2m (n=5)"
}

test_session_exact_hour() {
  clear_stats
  write_stats "sess-A" 2 7200   # exactly 2h
  run_statusline "$INPUT_FULL" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:2h (n=2)"
}

test_session_zero_count_omitted() {
  clear_stats
  write_stats "sess-A" 0 0
  run_statusline "$INPUT_FULL" "0.7"
  # Stats file exists but no events → no session block.
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%)"
}

test_no_session_id_no_session_block() {
  clear_stats
  # Stats writing requires session_id; if missing from input, the
  # statusline can't look it up — no session block.
  run_statusline "$INPUT_NO_SID" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%)"
}

test_throttle_off_ignores_session_stats() {
  clear_stats
  write_stats "sess-A" 5 1920
  # When throttle is off, session block is hidden even if stats exist.
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_cold_start_throttle_off() {
  clear_stats
  run_statusline "$INPUT_COLD" ""
  assert_stdout_eq "thr:off"
}

test_cold_start_throttle_on() {
  clear_stats
  run_statusline "$INPUT_COLD" "0.7"
  assert_stdout_eq "thr:0.7"
}

test_only_five_hour() {
  clear_stats
  run_statusline "$INPUT_ONLY_5H" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%)"
}

test_only_seven_day() {
  clear_stats
  run_statusline "$INPUT_ONLY_7D" "0.7"
  assert_stdout_eq "thr:0.7 | 7d:(79%/92%)"
}

test_window_just_started() {
  clear_stats
  # 5h window with 17999s remaining → 0% elapsed
  local input
  input=$(make_input 5 17999 absent 0 yes)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(5%/0%)"
}

test_window_almost_done() {
  clear_stats
  # 5h window with 100s remaining → 99% elapsed
  local input
  input=$(make_input 95 100 absent 0 yes)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(95%/99%)"
}

test_resets_at_in_past_treated_as_fresh() {
  clear_stats
  local input
  input=$(make_input 30 -100 absent 0 yes)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(30%/0%)"
}

test_window_incomplete_dropped() {
  clear_stats
  local input
  input=$(make_input incomplete 0 79 50400 yes)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 7d:(79%/92%)"
}

test_context_window() {
  clear_stats
  local input
  input=$(add_context "$INPUT_FULL" 213000 1000000 21)
  run_statusline "$input" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%) | 213k (21%)"
}

test_context_before_session_block() {
  clear_stats
  write_stats "sess-A" 5 1920
  local input
  input=$(add_context "$INPUT_FULL" 213000 1000000 21)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | 213k (21%) | session:32m (n=5)"
}

test_context_absent_field() {
  clear_stats
  # Older Claude Code versions don't send context_window at all.
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_context_cold_start() {
  clear_stats
  # current_usage is null until the first API response.
  local input
  input=$(add_context "$INPUT_FULL" none 1000000 0)
  run_statusline "$input" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)"
}

test_context_without_rate_limits() {
  clear_stats
  local input
  input=$(add_context "$INPUT_COLD" 213000 1000000 21)
  run_statusline "$input" ""
  assert_stdout_eq "thr:off | 213k (21%)"
}

test_context_small_token_count() {
  clear_stats
  # Under 1k tokens: raw count, no "k" suffix.
  local input
  input=$(add_context "$INPUT_ONLY_5H" 840 200000 0)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) | 840 (0%)"
}

test_context_pct_computed_when_missing() {
  clear_stats
  # used_percentage null -> fall back to tokens / context_window_size.
  local input
  input=$(add_context "$INPUT_ONLY_5H" 50000 200000 null)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) | 50k (25%)"
}

test_context_200k_window() {
  clear_stats
  local input
  input=$(add_context "$INPUT_ONLY_5H" 160000 200000 80)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) | 160k (80%)"
}

test_fable_shown() {
  clear_stats; clear_fable
  write_fable_cache 90 30 30
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%,90%/92%)" || return 1
  assert_not_spawned
}

test_fable_refresh_when_value_ages() {
  clear_stats; clear_fable
  # Value still displayable, attempt older than the 300s TTL: show it and
  # kick off a refresh in the background.
  write_fable_cache 90 600 600
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%,90%/92%)" || return 1
  assert_spawned
}

test_fable_stale_hidden() {
  clear_stats; clear_fable
  # Past the 900s display cutoff — refreshes have been failing.
  write_fable_cache 90 1200 1200
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_spawned
}

test_fable_other_account_hidden() {
  clear_stats; clear_fable
  # Cached against a token the session no longer uses (account switch).
  write_fable_cache 90 30 30 token-B
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_spawned
}

test_fable_null_pct_hidden() {
  clear_stats; clear_fable
  # Fetched fine, account just has no Fable bucket: nothing to show and
  # nothing to retry.
  write_fable_cache null 30 30
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_not_spawned
}

test_fable_refresh_when_cache_missing() {
  clear_stats; clear_fable
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_spawned
}

test_fable_disabled() {
  clear_stats; clear_fable
  write_fable_cache 90 30 30
  run_statusline "$INPUT_FULL" "" "0"
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_not_spawned
}

test_fable_no_credentials() {
  clear_stats; clear_fable
  write_fable_cache 90 30 30
  CREDS="$WORK/no-such-credentials.json"
  run_statusline "$INPUT_FULL" ""
  CREDS=""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%/92%)" || return 1
  assert_not_spawned
}

test_fable_from_model_scoped() {
  clear_stats; clear_fable
  local input
  input=$(add_model_scoped "$INPUT_FULL" Fable 84)
  run_statusline "$input" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%) 7d:(79%,84%/92%)" || return 1
  assert_not_spawned
}

test_fable_without_seven_day() {
  clear_stats; clear_fable
  # Fable rides along with the 7d block; no 7d data, nowhere to show it.
  write_fable_cache 90 30 30
  run_statusline "$INPUT_ONLY_5H" ""
  assert_stdout_eq "thr:off | 5h:(56%/80%)"
}

test_fable_with_throttle_and_context() {
  clear_stats; clear_fable
  write_stats "sess-A" 5 1920
  write_fable_cache 90 30 30
  local input
  input=$(add_context "$INPUT_FULL" 213000 1000000 21)
  run_statusline "$input" "0.7"
  assert_stdout_eq "thr:0.7 | 5h:(56%/80%) 7d:(79%,90%/92%) | 213k (21%) | session:32m (n=5)"
}

# --- run all tests ---

run "throttle off, full data"                  test_throttle_off
run "throttle=0, full data"                    test_throttle_zero
run "throttle=garbage, full data"              test_throttle_garbage
run "throttle=negative, full data"             test_throttle_negative
run "throttle on, no stats yet"                test_throttle_on_no_stats
run "multiplier preserved verbatim"            test_throttle_multiplier_verbatim
run "session stats: minutes"                   test_session_minutes
run "session stats: seconds"                   test_session_seconds
run "session stats: hours and minutes"         test_session_hours_minutes
run "session stats: exact hour"                test_session_exact_hour
run "session stats: zero count omitted"        test_session_zero_count_omitted
run "no session_id: no session block"          test_no_session_id_no_session_block
run "throttle off ignores session stats"       test_throttle_off_ignores_session_stats
run "cold start, throttle off"                 test_cold_start_throttle_off
run "cold start, throttle on"                  test_cold_start_throttle_on
run "only five_hour present"                   test_only_five_hour
run "only seven_day present"                   test_only_seven_day
run "window just started (0% elapsed)"         test_window_just_started
run "window almost done (99% elapsed)"         test_window_almost_done
run "resets_at in past treated as fresh"       test_resets_at_in_past_treated_as_fresh
run "incomplete window silently dropped"       test_window_incomplete_dropped
run "context window block"                     test_context_window
run "context block precedes session block"     test_context_before_session_block
run "no context_window field: block omitted"   test_context_absent_field
run "cold start: context block omitted"        test_context_cold_start
run "context block without rate limits"        test_context_without_rate_limits
run "context: sub-1k token count"              test_context_small_token_count
run "context: pct computed when null"          test_context_pct_computed_when_missing
run "context: 200k window"                     test_context_200k_window
run "fable: cached pct shown in 7d block"      test_fable_shown
run "fable: shown while refresh is due"        test_fable_refresh_when_value_ages
run "fable: stale value hidden"                test_fable_stale_hidden
run "fable: other account value hidden"        test_fable_other_account_hidden
run "fable: null pct hidden, no refetch"       test_fable_null_pct_hidden
run "fable: missing cache triggers refresh"    test_fable_refresh_when_cache_missing
run "fable: CLAUDE_THROTTLE_FABLE=0 disables"  test_fable_disabled
run "fable: no credentials, no fetch"          test_fable_no_credentials
run "fable: model_scoped from statusLine JSON" test_fable_from_model_scoped
run "fable: hidden when 7d window absent"      test_fable_without_seven_day
run "fable: alongside throttle+context blocks" test_fable_with_throttle_and_context

echo
echo "----"
echo "Tests run:    $TESTS_RUN"
echo "Tests failed: $TESTS_FAILED"
if (( TESTS_FAILED > 0 )); then
  echo "Failed cases:"
  for n in "${FAILED_NAMES[@]}"; do
    echo "  - $n"
  done
  exit 1
fi
exit 0
