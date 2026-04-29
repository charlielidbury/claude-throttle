#!/usr/bin/env bash
# Unit tests for scripts/statusline.sh.
#
# Verifies the visible status bar text under various conditions:
# - With/without rate_limits in input
# - With CLAUDE_THROTTLE unset/empty/zero/positive
# - With/without per-session stats file
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

TESTS_RUN=0
TESTS_FAILED=0
FAILED_NAMES=()

# Run statusline.sh with the given JSON input and CLAUDE_THROTTLE value.
# Stores stdout in $LAST_STDOUT.
LAST_STDOUT=""
run_statusline() {
  local input_json="$1"
  local throttle_val="${2:-}"
  LAST_STDOUT=$(
    CLAUDE_THROTTLE="$throttle_val" \
    CLAUDE_THROTTLE_CACHE="$CACHE_FILE" \
    CLAUDE_THROTTLE_STATS_DIR="$STATS_DIR" \
    "$STATUSLINE_SH" <<<"$input_json" 2>/dev/null
  )
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

# Canned input with rate_limits and a session_id.
INPUT_FULL='{"session_id":"sess-A","rate_limits":{"five_hour":{"used_percentage":56,"resets_at":1777468800},"seven_day":{"used_percentage":79,"resets_at":1777482000}}}'

# Canned input with no rate_limits (cold start).
INPUT_COLD='{"session_id":"sess-A","rate_limits":null}'

# --- test cases ---

test_throttle_off_shows_rate_limits_only() {
  run_statusline "$INPUT_FULL" ""
  assert_stdout_eq "5h:56% 7d:79%"
}

test_throttle_off_zero() {
  run_statusline "$INPUT_FULL" "0"
  assert_stdout_eq "5h:56% 7d:79%"
}

test_throttle_off_garbage() {
  run_statusline "$INPUT_FULL" "foo"
  assert_stdout_eq "5h:56% 7d:79%"
}

test_throttle_on_no_stats() {
  rm -f "$STATS_DIR"/*.json
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9"
}

test_throttle_on_with_stats_minutes() {
  rm -f "$STATS_DIR"/*.json
  write_stats "sess-A" 3 720   # 12m, 3 events
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9 [12m/3]"
}

test_throttle_on_with_stats_seconds() {
  rm -f "$STATS_DIR"/*.json
  write_stats "sess-A" 1 45    # 45s, 1 event
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9 [45s/1]"
}

test_throttle_on_with_stats_hours() {
  rm -f "$STATS_DIR"/*.json
  write_stats "sess-A" 5 3725   # 1h2m, 5 events
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9 [1h2m/5]"
}

test_throttle_on_with_stats_exact_hour() {
  rm -f "$STATS_DIR"/*.json
  write_stats "sess-A" 2 7200   # exactly 2h
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9 [2h/2]"
}

test_cold_start_throttle_off() {
  rm -f "$STATS_DIR"/*.json
  run_statusline "$INPUT_COLD" ""
  assert_stdout_eq ""
}

test_cold_start_throttle_on_no_stats() {
  rm -f "$STATS_DIR"/*.json
  run_statusline "$INPUT_COLD" "1.0"
  assert_stdout_eq "thr:1.0"
}

test_throttle_on_stats_present_but_zero_count() {
  # If stats file exists but throttle_count is 0, should NOT show [DUR/0].
  rm -f "$STATS_DIR"/*.json
  write_stats "sess-A" 0 0
  run_statusline "$INPUT_FULL" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9"
}

test_throttle_multiplier_preserved() {
  rm -f "$STATS_DIR"/*.json
  run_statusline "$INPUT_FULL" "0.50"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.50"
}

test_no_session_id_throttle_on() {
  # If session_id missing from input, can't look up stats — show thr:M without [].
  rm -f "$STATS_DIR"/*.json
  local input='{"rate_limits":{"five_hour":{"used_percentage":56,"resets_at":1777468800},"seven_day":{"used_percentage":79,"resets_at":1777482000}}}'
  run_statusline "$input" "0.9"
  assert_stdout_eq "5h:56% 7d:79% | thr:0.9"
}

# --- run all tests ---

run "throttle off: rate limits only"               test_throttle_off_shows_rate_limits_only
run "throttle=0: rate limits only"                 test_throttle_off_zero
run "throttle=garbage: rate limits only"           test_throttle_off_garbage
run "throttle on, no stats yet"                    test_throttle_on_no_stats
run "throttle on, stats in minutes"                test_throttle_on_with_stats_minutes
run "throttle on, stats in seconds"                test_throttle_on_with_stats_seconds
run "throttle on, stats with hours and minutes"    test_throttle_on_with_stats_hours
run "throttle on, stats exact hour (no minutes)"   test_throttle_on_with_stats_exact_hour
run "cold start: throttle off → empty"             test_cold_start_throttle_off
run "cold start: throttle on → just thr"           test_cold_start_throttle_on_no_stats
run "stats present but zero count → no []"         test_throttle_on_stats_present_but_zero_count
run "multiplier formatted as user wrote it"        test_throttle_multiplier_preserved
run "no session_id, throttle on → thr only"        test_no_session_id_throttle_on

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
