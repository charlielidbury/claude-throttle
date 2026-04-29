#!/usr/bin/env bash
# Unit tests for scripts/statusline.sh.
#
# Verifies the visible status bar text under various conditions:
# - With/without rate_limits in input
# - With CLAUDE_THROTTLE unset/empty/zero/positive
# - With/without per-session stats file
# - With one or both windows present
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
  LAST_STDOUT=$(
    CLAUDE_THROTTLE="$throttle_val" \
    CLAUDE_THROTTLE_CACHE="$CACHE_FILE" \
    CLAUDE_THROTTLE_STATS_DIR="$STATS_DIR" \
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
