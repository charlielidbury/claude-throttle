#!/usr/bin/env bash
# Unit tests for scripts/fable-usage.py.
#
# Runs the fetcher against a local stand-in for /api/oauth/usage, so
# every case is hermetic: no network, no real credentials.
# - Parsing the Fable weekly window out of a limits[] payload
# - TTL: repeat runs inside the window make no request
# - Account switch: values do not carry across tokens
# - 429 backoff, 5xx, expired token, missing credentials
set -u

REPO_ROOT="$(cd "$(dirname "$(realpath "$0")")/.." && pwd)"
FETCHER="$REPO_ROOT/scripts/fable-usage.py"

if [[ ! -r "$FETCHER" ]]; then
  echo "ERROR: $FETCHER not found" >&2
  exit 2
fi

WORK=$(mktemp -d)
SERVER_PID=""
cleanup() {
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

CACHE="$WORK/fable.json"
CREDS="$WORK/credentials.json"
MODE_FILE="$WORK/mode"
REQ_LOG="$WORK/requests.log"
PORT_FILE="$WORK/port"

TESTS_RUN=0
TESTS_FAILED=0
FAILED_NAMES=()

# --- stand-in usage endpoint ---
# Responds according to $MODE_FILE and logs "<path> <authorization>" per
# request so tests can assert both call count and the bearer token sent.
cat > "$WORK/server.py" <<'PYEOF'
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MODE_FILE = os.environ["MODE_FILE"]
REQ_LOG = os.environ["REQ_LOG"]
PORT_FILE = os.environ["PORT_FILE"]

FABLE_LIMIT = {
    "kind": "weekly_scoped",
    "group": "weekly",
    "percent": 90,
    "severity": "critical",
    "resets_at": "2026-08-26T02:59:59.634066+00:00",
    "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None},
    "is_active": True,
}
BASE_LIMITS = [
    {"kind": "session", "group": "session", "percent": 21, "scope": None},
    {"kind": "weekly_all", "group": "weekly", "percent": 48, "scope": None},
]


def payload(with_fable):
    return {
        "five_hour": {"utilization": 21.0, "resets_at": "2026-08-24T17:59:59+00:00"},
        "seven_day": {"utilization": 48.0, "resets_at": "2026-08-26T02:59:59+00:00"},
        "seven_day_opus": None,
        "limits": BASE_LIMITS + ([FABLE_LIMIT] if with_fable else []),
    }


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(REQ_LOG, "a") as f:
            f.write("%s %s\n" % (self.path, self.headers.get("Authorization", "-")))
        mode = open(MODE_FILE).read().strip()
        if mode == "429":
            self.send_response(429)
            self.send_header("Retry-After", "300")
            self.end_headers()
            self.wfile.write(b"slow down")
            return
        if mode == "500":
            self.send_response(500)
            self.end_headers()
            self.wfile.write(b"boom")
            return
        body = json.dumps(payload(mode != "nofable")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(PORT_FILE, "w") as f:
    f.write(str(server.server_address[1]))
server.serve_forever()
PYEOF

: > "$REQ_LOG"
echo ok > "$MODE_FILE"
MODE_FILE="$MODE_FILE" REQ_LOG="$REQ_LOG" PORT_FILE="$PORT_FILE" \
  python3 "$WORK/server.py" &
SERVER_PID=$!

for _ in $(seq 50); do
  [[ -s "$PORT_FILE" ]] && break
  sleep 0.1
done
if [[ ! -s "$PORT_FILE" ]]; then
  echo "ERROR: stand-in server did not start" >&2
  exit 2
fi
USAGE_URL="http://127.0.0.1:$(cat "$PORT_FILE")/api/oauth/usage"

# --- helpers ---
# $1 access token, $2 expiresAt in ms ("valid" for far future, "expired")
write_creds() {
  python3 -c '
import json, sys, time
token, expiry = sys.argv[2:4]
ms = (time.time() + 86400) * 1000 if expiry == "valid" else (time.time() - 60) * 1000
with open(sys.argv[1], "w") as f:
    json.dump({"claudeAiOauth": {"accessToken": token, "expiresAt": int(ms)}}, f)
' "$CREDS" "$1" "$2"
}

# $1 TTL seconds
run_fetcher() {
  CLAUDE_THROTTLE_FABLE_CACHE="$CACHE" \
  CLAUDE_THROTTLE_FABLE_TTL="$1" \
  CLAUDE_THROTTLE_USAGE_URL="$USAGE_URL" \
  CLAUDE_CREDENTIALS="$CREDS" \
    python3 "$FETCHER"
}

# Prints one cache field. Relative times print as an offset from now,
# rounded, so assertions do not depend on wall-clock.
cache_field() {
  python3 -c '
import json, sys, time
try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except (OSError, ValueError):
    print("<no-cache>")
    sys.exit(0)
key = sys.argv[2]
value = data.get(key)
if key.endswith("_at") and isinstance(value, (int, float)):
    print(int(round(value - time.time())))
else:
    print(value)
' "$CACHE" "$1"
}

token_fp() {
  python3 -c '
import hashlib, sys
print(hashlib.sha256(sys.argv[1].encode("utf-8")).hexdigest()[:16])
' "$1"
}

request_count() { wc -l < "$REQ_LOG" | tr -d " "; }

assert_eq() {
  local what="$1" want="$2" got="$3"
  if [[ "$got" != "$want" ]]; then
    echo "  FAIL: $what"
    echo "    want: $want"
    echo "    got:  $got"
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

reset() {
  rm -f "$CACHE"
  : > "$REQ_LOG"
  echo "${1:-ok}" > "$MODE_FILE"
  write_creds "token-A" valid
}

# --- test cases ---

test_fetch_writes_pct() {
  reset ok
  run_fetcher 120
  assert_eq "fable_pct" "90.0" "$(cache_field fable_pct)" || return 1
  assert_eq "token_fp" "$(token_fp token-A)" "$(cache_field token_fp)" || return 1
  assert_eq "fetched_at offset" "0" "$(cache_field fetched_at)" || return 1
  assert_eq "requests" "1" "$(request_count)"
}

test_sends_bearer_token() {
  reset ok
  run_fetcher 120
  assert_eq "request line" "/api/oauth/usage Bearer token-A" "$(cat "$REQ_LOG")"
}

test_ttl_skips_second_run() {
  reset ok
  run_fetcher 120
  run_fetcher 120
  assert_eq "requests" "1" "$(request_count)" || return 1
  assert_eq "fable_pct" "90.0" "$(cache_field fable_pct)"
}

test_zero_ttl_refetches() {
  reset ok
  run_fetcher 0
  run_fetcher 0
  assert_eq "requests" "2" "$(request_count)"
}

test_account_without_fable_bucket() {
  reset nofable
  run_fetcher 120
  assert_eq "fable_pct" "None" "$(cache_field fable_pct)" || return 1
  assert_eq "fetched_at offset" "0" "$(cache_field fetched_at)"
}

test_server_error_keeps_last_value() {
  reset ok
  run_fetcher 0
  echo 500 > "$MODE_FILE"
  run_fetcher 0
  # Last good number survives; the attempt is stamped so the next render
  # waits out the TTL instead of retrying immediately.
  assert_eq "fable_pct" "90.0" "$(cache_field fable_pct)" || return 1
  assert_eq "attempted_at offset" "0" "$(cache_field attempted_at)" || return 1
  assert_eq "requests" "2" "$(request_count)"
}

test_429_backs_off() {
  reset ok
  run_fetcher 0
  echo 429 > "$MODE_FILE"
  run_fetcher 0
  # Retry-After: 300 parks the next attempt ~5 minutes out.
  local offset
  offset=$(cache_field attempted_at)
  if (( offset < 295 || offset > 300 )); then
    echo "  FAIL: attempted_at should be ~300s ahead, got ${offset}s"
    return 1
  fi
  assert_eq "fable_pct" "90.0" "$(cache_field fable_pct)"
}

test_expired_token_makes_no_request() {
  reset ok
  write_creds "token-A" expired
  run_fetcher 120
  assert_eq "requests" "0" "$(request_count)" || return 1
  # Attempt still recorded, so renders do not respawn it every time.
  assert_eq "attempted_at offset" "0" "$(cache_field attempted_at)" || return 1
  assert_eq "fetched_at" "None" "$(cache_field fetched_at)"
}

test_missing_credentials() {
  reset ok
  rm -f "$CREDS"
  run_fetcher 120
  assert_eq "cache" "<no-cache>" "$(cache_field fable_pct)" || return 1
  assert_eq "requests" "0" "$(request_count)"
}

test_account_switch_drops_old_value() {
  reset ok
  run_fetcher 120
  echo 500 > "$MODE_FILE"
  write_creds "token-B" valid
  # Inside the TTL, but a different token: refetch, and do not carry the
  # previous account number over even though the refetch failed.
  run_fetcher 120
  assert_eq "fable_pct" "None" "$(cache_field fable_pct)" || return 1
  assert_eq "fetched_at" "None" "$(cache_field fetched_at)" || return 1
  assert_eq "token_fp" "$(token_fp token-B)" "$(cache_field token_fp)" || return 1
  assert_eq "requests" "2" "$(request_count)"
}

test_corrupt_cache_recovers() {
  reset ok
  echo "not json" > "$CACHE"
  run_fetcher 120
  assert_eq "fable_pct" "90.0" "$(cache_field fable_pct)"
}

# --- run all tests ---

run "fetch writes fable_pct"                   test_fetch_writes_pct
run "sends the oauth bearer token"             test_sends_bearer_token
run "ttl skips a second run"                   test_ttl_skips_second_run
run "ttl=0 refetches"                          test_zero_ttl_refetches
run "account with no Fable bucket -> null"     test_account_without_fable_bucket
run "5xx keeps the last good value"            test_server_error_keeps_last_value
run "429 honours Retry-After"                  test_429_backs_off
run "expired token makes no request"           test_expired_token_makes_no_request
run "missing credentials: no cache, no call"   test_missing_credentials
run "account switch drops the old value"       test_account_switch_drops_old_value
run "corrupt cache file recovers"              test_corrupt_cache_recovers

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
