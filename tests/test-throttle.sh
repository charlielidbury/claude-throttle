#!/usr/bin/env bash
# Unit tests for scripts/throttle.sh.
#
# Each test:
#   1. Sets up env vars and writes a canned cache file.
#   2. Invokes throttle.sh with stdin redirected (mock PreToolUse JSON).
#   3. Asserts on exit code, captured sleep duration, stdout, and log.
#
# Sleep is mocked via a shim binary placed earlier on PATH; the shim
# writes the requested duration to $SLEEP_RECORD and returns 0
# immediately, so tests run instantly.
set -u

REPO_ROOT="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"
THROTTLE_SH="$REPO_ROOT/scripts/throttle.sh"

if [[ ! -x "$THROTTLE_SH" ]]; then
  echo "ERROR: $THROTTLE_SH not found or not executable" >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

MOCK_BIN="$WORK/bin"
mkdir -p "$MOCK_BIN"
cat > "$MOCK_BIN/sleep" <<'SHIM'
#!/usr/bin/env bash
printf '%s' "$1" > "${SLEEP_RECORD:-/dev/null}"
exit 0
SHIM
chmod +x "$MOCK_BIN/sleep"

CACHE_FILE="$WORK/cache.json"
LOG_FILE="$WORK/throttle.log"
STDOUT_FILE="$WORK/stdout"
STDERR_FILE="$WORK/stderr"
SLEEP_RECORD="$WORK/sleep_record"
STATS_DIR="$WORK/stats"
mkdir -p "$STATS_DIR"

TESTS_RUN=0
TESTS_FAILED=0
FAILED_NAMES=()
LAST_EXIT=0

reset_state() {
  rm -f "$CACHE_FILE" "$LOG_FILE" "$STDOUT_FILE" "$STDERR_FILE" "$SLEEP_RECORD"
  rm -f "$STATS_DIR"/*.json 2>/dev/null || true
}

# Build a cache file at $CACHE_FILE.
# Args (positional):
#   $1 captured_age_s   seconds before "now" the cache was captured (use 0 for fresh)
#   $2 fh_used_pct      number, "null", or "absent" (omit five_hour entirely)
#   $3 fh_resets_in_s   number, "null"; ignored if fh is absent
#   $4 sd_used_pct      number, "null", or "absent" (omit seven_day entirely); default "absent"
#   $5 sd_resets_in_s   number, "null"; ignored if sd is absent
# If $2 == "rate_limits_null" the whole rate_limits field is null (cold start).
write_cache() {
  python3 - "$CACHE_FILE" "$@" <<'PY'
import json, sys, time
out_path = sys.argv[1]
captured_age = float(sys.argv[2])
fh_pct = sys.argv[3]
fh_resets = sys.argv[4]
sd_pct = sys.argv[5] if len(sys.argv) > 5 else 'absent'
sd_resets = sys.argv[6] if len(sys.argv) > 6 else 'null'

now = time.time()
captured_at = now - captured_age

if fh_pct == 'rate_limits_null':
    payload = {'captured_at': captured_at, 'rate_limits': None}
else:
    rl = {}
    if fh_pct != 'absent':
        fh = {}
        fh['used_percentage'] = None if fh_pct == 'null' else float(fh_pct)
        fh['resets_at'] = None if fh_resets == 'null' else now + float(fh_resets)
        rl['five_hour'] = fh
    if sd_pct != 'absent':
        sd = {}
        sd['used_percentage'] = None if sd_pct == 'null' else float(sd_pct)
        sd['resets_at'] = None if sd_resets == 'null' else now + float(sd_resets)
        rl['seven_day'] = sd
    payload = {'captured_at': captured_at, 'rate_limits': rl}

with open(out_path, 'w') as f:
    json.dump(payload, f)
PY
}

write_cache_raw() {
  printf '%s' "$1" > "$CACHE_FILE"
}

run_throttle() {
  # Optional first arg: stdin input string. Default: empty stdin.
  local stdin_input="${1:-}"
  PATH="$MOCK_BIN:$PATH" \
    THROTTLE_LOG="$LOG_FILE" \
    CLAUDE_THROTTLE_CACHE="$CACHE_FILE" \
    CLAUDE_THROTTLE_STATS_DIR="$STATS_DIR" \
    SLEEP_RECORD="$SLEEP_RECORD" \
    "$THROTTLE_SH" <<<"$stdin_input" >"$STDOUT_FILE" 2>"$STDERR_FILE"
  LAST_EXIT=$?
}

# --- assertions ---

fail_msg() {
  echo "  FAIL: $1"
  if [[ -s "$LOG_FILE" ]]; then
    echo "  log: $(cat "$LOG_FILE")"
  fi
  if [[ -s "$STDOUT_FILE" ]]; then
    echo "  stdout: $(cat "$STDOUT_FILE")"
  fi
  if [[ -s "$STDERR_FILE" ]]; then
    echo "  stderr: $(cat "$STDERR_FILE")"
  fi
  if [[ -s "$SLEEP_RECORD" ]]; then
    echo "  sleep: $(cat "$SLEEP_RECORD")"
  fi
}

assert_exit_zero() {
  if [[ "$LAST_EXIT" -ne 0 ]]; then
    fail_msg "expected exit 0, got $LAST_EXIT"
    return 1
  fi
}

assert_no_stdout() {
  if [[ -s "$STDOUT_FILE" ]]; then
    fail_msg "expected empty stdout"
    return 1
  fi
}

assert_no_sleep() {
  if [[ -s "$SLEEP_RECORD" ]]; then
    fail_msg "expected no sleep, got $(cat "$SLEEP_RECORD")"
    return 1
  fi
}

assert_no_log() {
  if [[ -s "$LOG_FILE" ]]; then
    fail_msg "expected empty log"
    return 1
  fi
}

assert_log_matches() {
  if ! grep -qE "$1" "$LOG_FILE"; then
    fail_msg "log did not match /$1/"
    return 1
  fi
}

assert_sleep_eq() {
  local want="$1"
  if [[ ! -s "$SLEEP_RECORD" ]]; then
    fail_msg "expected sleep $want, got no sleep"
    return 1
  fi
  local got
  got=$(cat "$SLEEP_RECORD")
  # Compare as floats with small tolerance
  if ! python3 -c "import sys; want=float(sys.argv[1]); got=float(sys.argv[2]); sys.exit(0 if abs(want-got) < 0.5 else 1)" "$want" "$got"; then
    fail_msg "expected sleep $want, got $got"
    return 1
  fi
}

assert_sleep_in_range() {
  local lo="$1" hi="$2"
  if [[ ! -s "$SLEEP_RECORD" ]]; then
    fail_msg "expected sleep in [$lo, $hi], got no sleep"
    return 1
  fi
  local got
  got=$(cat "$SLEEP_RECORD")
  if ! python3 -c "import sys; lo=float(sys.argv[1]); hi=float(sys.argv[2]); got=float(sys.argv[3]); sys.exit(0 if lo <= got <= hi else 1)" "$lo" "$hi" "$got"; then
    fail_msg "expected sleep in [$lo, $hi], got $got"
    return 1
  fi
}

assert_stdout_valid_systemmessage() {
  if ! python3 -c '
import json, sys
d = json.load(sys.stdin)
assert isinstance(d, dict)
assert isinstance(d.get("systemMessage"), str)
assert d["systemMessage"]
' < "$STDOUT_FILE" 2>/dev/null; then
    fail_msg "stdout is not valid JSON with non-empty systemMessage"
    return 1
  fi
}

# Stats helpers — assert per-session stats file state in $STATS_DIR.
stats_file_for() {
  printf '%s/claude-throttle-stats-%s.json' "$STATS_DIR" "$1"
}

assert_no_stats_files() {
  local count
  count=$(find "$STATS_DIR" -maxdepth 1 -name '*.json' -type f 2>/dev/null | wc -l)
  if (( count > 0 )); then
    fail_msg "expected no stats files; found $count: $(ls "$STATS_DIR")"
    return 1
  fi
}

# assert_stats <sid> <expected_count> <expected_total_sleep_s>
assert_stats() {
  local sid="$1" want_count="$2" want_total="$3"
  local file
  file=$(stats_file_for "$sid")
  if [[ ! -f "$file" ]]; then
    fail_msg "expected stats file $file"
    return 1
  fi
  python3 - "$file" "$want_count" "$want_total" <<'PY' 2>/dev/null
import json, sys
file, want_count, want_total = sys.argv[1], int(sys.argv[2]), float(sys.argv[3])
with open(file) as f:
    d = json.load(f)
assert isinstance(d, dict), f"not an object: {d!r}"
assert int(d.get("throttle_count", -1)) == want_count, f"count: {d.get('throttle_count')} vs {want_count}"
got_total = float(d.get("total_sleep_s", -1))
assert abs(got_total - want_total) < 0.5, f"total: {got_total} vs {want_total}"
assert isinstance(d.get("last_sleep_at"), int), f"last_sleep_at: {d.get('last_sleep_at')!r}"
PY
  if (( $? != 0 )); then
    fail_msg "stats file mismatch (sid=$sid want_count=$want_count want_total=$want_total)"
    if [[ -f "$file" ]]; then
      echo "  contents: $(cat "$file")"
    fi
    return 1
  fi
}

# Build a PreToolUse-style JSON payload with the given session_id (or no key if "absent").
make_input() {
  local sid="${1:-absent}"
  if [[ "$sid" == "absent" ]]; then
    echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{}}'
  else
    printf '{"session_id":"%s","hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{}}' "$sid"
  fi
}

# --- test runner ---

run() {
  local name="$1"; shift
  TESTS_RUN=$((TESTS_RUN + 1))
  echo "TEST: $name"
  if ! "$@"; then
    TESTS_FAILED=$((TESTS_FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
}

# --- test cases ---

# 1. Throttle disabled (unset)
test_disabled_unset() {
  reset_state
  unset CLAUDE_THROTTLE
  run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_no_log
}

# 2. Throttle disabled (empty)
test_disabled_empty() {
  reset_state
  CLAUDE_THROTTLE="" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_no_log
}

# 3. Throttle disabled (zero)
test_disabled_zero() {
  reset_state
  CLAUDE_THROTTLE="0" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_no_log
}

# 4. Throttle disabled (garbage)
test_disabled_garbage() {
  reset_state
  CLAUDE_THROTTLE="foo" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_no_log
}

# 5. No cache file
test_no_cache_file() {
  reset_state
  CLAUDE_THROTTLE="0.9" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "no cache file"
}

# 6. Stale cache
test_stale_cache() {
  reset_state
  write_cache 600 25 16200
  CLAUDE_THROTTLE="0.9" MAX_CACHE_AGE_S="300" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "stale cache"
}

# 7. Cold start (rate_limits=null)
test_cold_start() {
  reset_state
  write_cache 0 rate_limits_null null
  CLAUDE_THROTTLE="0.9" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "cold start|no rate_limits"
}

# 8. Warmup bypass, 5h
# 5h=5%, elapsed=0s (resets_at = now+18000)
test_warmup_5h() {
  reset_state
  write_cache 0 5 18000
  CLAUDE_THROTTLE="0.9" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "warmup"
}

# 9. Warmup bypass even when ahead
# 5h=7.5%, elapsed=60s (resets_at = now + (18000-60) = now+17940), throttle=0.5
# Without bypass: target = 0.075 * 18000 / 0.5 = 2700; sleep = 2700 - 60 = 2640s
test_warmup_bypass_when_ahead() {
  reset_state
  write_cache 0 7.5 17940
  CLAUDE_THROTTLE="0.5" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "warmup"
}

# 10. Just over warmup: 5h=10.5%, elapsed=900s (resets_at = now+17100)
# At throttle=1.0: target = 0.105 * 18000 = 1890; sleep = 1890-900 = 990, capped to 540
test_just_over_warmup() {
  reset_state
  write_cache 0 10.5 17100
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 540 \
    && assert_stdout_valid_systemmessage \
    && assert_log_matches "sleep:"
}

# 11. Behind pace, throttle=1.0: 5h=25%, elapsed=9000s (resets_at = now+9000)
# target = 0.25 * 18000 = 4500; sleep = max(0, 4500-9000) = 0
test_behind_pace() {
  reset_state
  write_cache 0 25 9000
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "skip:"
}

# 12. On pace, throttle=1.0: 5h=20%, elapsed=3600s (resets_at = now+14400)
# target = 0.2 * 18000 = 3600; sleep = max(0, 3600-3600) = 0
test_on_pace() {
  reset_state
  write_cache 0 20 14400
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "skip:"
}

# 13. Ahead of pace, throttle=1.0: 5h=20%, elapsed=1800s (resets_at = now+16200)
# target = 0.2 * 18000 = 3600; sleep = 3600-1800 = 1800, capped to 540
test_ahead_of_pace_capped() {
  reset_state
  write_cache 0 20 16200
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 540 \
    && assert_stdout_valid_systemmessage \
    && assert_log_matches "sleep:"
}

# 14. Multiplier kicks in, throttle=0.5: 5h=20%, elapsed=3600s (resets_at = now+14400)
# target = 0.2 * 18000 / 0.5 = 7200; sleep = 7200-3600 = 3600, capped to 540
test_multiplier_kicks_in() {
  reset_state
  write_cache 0 20 14400
  CLAUDE_THROTTLE="0.5" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 540 \
    && assert_stdout_valid_systemmessage \
    && assert_log_matches "sleep:"
}

# 15. Both windows ahead: 5h ahead by 100s, 7d ahead by 300s; sleep = 300
# 5h: choose used_pct=30%, want sleep=100. target = 0.3*18000/1.0 = 5400; elapsed = 5300; remaining=12700
# 7d: choose used_pct=50%, want sleep=300. target = 0.5*604800/1.0 = 302400; elapsed = 302100; remaining = 302700
test_both_windows_max() {
  reset_state
  write_cache 0 30 12700 50 302700
  CLAUDE_THROTTLE="1.0" MAX_SLEEP="540" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 300 \
    && assert_stdout_valid_systemmessage \
    && assert_log_matches "sleep:"
}

# 16. 7d resets_at null (5h still pacing, 7d ignored)
# 5h ahead by 100s as above
test_7d_resets_at_null() {
  reset_state
  write_cache 0 30 12700 50 null
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 100 \
    && assert_stdout_valid_systemmessage
}

# 17. Missing 7d entirely
test_missing_7d() {
  reset_state
  write_cache 0 30 12700 absent
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_sleep_eq 100 \
    && assert_stdout_valid_systemmessage
}

# 18. Invalid cache JSON
test_invalid_cache_json() {
  reset_state
  write_cache_raw "this is not json {{{"
  CLAUDE_THROTTLE="0.9" run_throttle
  assert_exit_zero \
    && assert_no_stdout \
    && assert_no_sleep \
    && assert_log_matches "invalid cache JSON|skip:"
}

# 19. Stdout JSON validity for the canonical sleep case
test_stdout_json_validity() {
  reset_state
  write_cache 0 20 16200
  CLAUDE_THROTTLE="1.0" run_throttle
  assert_exit_zero \
    && assert_stdout_valid_systemmessage
}

# 20. Stats file is created on first sleep when session_id is in stdin
test_stats_first_sleep() {
  reset_state
  write_cache 0 20 16200   # ahead-of-pace, sleep capped to 540
  CLAUDE_THROTTLE="1.0" run_throttle "$(make_input s-001)"
  assert_exit_zero \
    && assert_sleep_eq 540 \
    && assert_stats "s-001" 1 540
}

# 21. Two consecutive sleeps in the same session: counter=2, total summed
test_stats_two_sleeps() {
  reset_state
  write_cache 0 20 16200
  CLAUDE_THROTTLE="1.0" run_throttle "$(make_input s-002)"
  assert_exit_zero || return 1
  # second invocation in same session, same canned cache
  write_cache 0 20 16200
  CLAUDE_THROTTLE="1.0" run_throttle "$(make_input s-002)"
  assert_exit_zero \
    && assert_stats "s-002" 2 1080
}

# 22. Sleep with malformed stdin (no session_id): sleep happens, no stats file
test_stats_no_session_id() {
  reset_state
  write_cache 0 20 16200
  CLAUDE_THROTTLE="1.0" run_throttle "$(make_input absent)"
  assert_exit_zero \
    && assert_sleep_eq 540 \
    && assert_no_stats_files
}

# 23. Throttle disabled: no stats writing even with session_id
test_stats_throttle_disabled() {
  reset_state
  write_cache 0 20 16200
  CLAUDE_THROTTLE="" run_throttle "$(make_input s-003)"
  assert_exit_zero \
    && assert_no_sleep \
    && assert_no_stats_files
}

# 24. Skip path doesn't write stats (behind pace, has session_id)
test_stats_skip_path_no_write() {
  reset_state
  write_cache 0 25 9000  # behind pace
  CLAUDE_THROTTLE="1.0" run_throttle "$(make_input s-004)"
  assert_exit_zero \
    && assert_no_sleep \
    && assert_no_stats_files
}

# --- run all tests ---

run "throttle disabled (unset)"        test_disabled_unset
run "throttle disabled (empty)"        test_disabled_empty
run "throttle disabled (zero)"         test_disabled_zero
run "throttle disabled (garbage)"      test_disabled_garbage
run "no cache file"                    test_no_cache_file
run "stale cache"                      test_stale_cache
run "cold start (rate_limits null)"    test_cold_start
run "warmup bypass, 5h"                test_warmup_5h
run "warmup bypass even when ahead"    test_warmup_bypass_when_ahead
run "just over warmup"                 test_just_over_warmup
run "behind pace, throttle=1.0"        test_behind_pace
run "on pace, throttle=1.0"            test_on_pace
run "ahead of pace, capped at 540"     test_ahead_of_pace_capped
run "multiplier=0.5 kicks in"          test_multiplier_kicks_in
run "both windows ahead, max wins"     test_both_windows_max
run "7d resets_at null, 5h paces"      test_7d_resets_at_null
run "7d entirely missing, 5h paces"    test_missing_7d
run "invalid cache JSON"               test_invalid_cache_json
run "stdout valid JSON systemMessage"  test_stdout_json_validity
run "stats: first sleep writes stats"  test_stats_first_sleep
run "stats: two sleeps accumulate"     test_stats_two_sleeps
run "stats: no session_id, no stats"   test_stats_no_session_id
run "stats: throttle disabled, none"   test_stats_throttle_disabled
run "stats: skip path, no stats"       test_stats_skip_path_no_write

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
