#!/usr/bin/env python3
"""Refresh the cached Fable weekly-limit percentage for the status bar.

statusLine JSON carries only the aggregate windows: Claude Code builds
rate_limits from the anthropic-ratelimit-unified-{5h,7d}-* response
headers, which have no per-model buckets. The Fable weekly window lives
only in the /api/oauth/usage payload (the data /usage renders), as a
limits[] entry of kind "weekly_scoped" whose scope.model.display_name is
"Fable".

So statusline.sh spawns this script detached whenever its cache is older
than the TTL and prints whatever the cache already holds — a slow or
failing request never stalls the status bar. Display only; the throttle
hook still paces off the statusLine cache alone (see
docs/rejected-endpoint-approach.md).

Credentials are read, never written: the access token goes out as a
bearer token and is never refreshed here, since rotating it would pull
the token out from under the account switcher.

Cache file, written atomically:

    {"attempted_at": 1787578046,   last attempt, or a backoff deadline
     "fetched_at":   1787578046,   last success, null if never
     "fable_pct":    90.0,         null when the account has no Fable bucket
     "token_fp":     "3f2a..."}    which token the value belongs to

Env:
    CLAUDE_THROTTLE_FABLE_CACHE  cache path (default /tmp/claude-throttle-fable.json)
    CLAUDE_THROTTLE_FABLE_TTL    seconds between attempts (default 300)
    CLAUDE_CREDENTIALS           credentials file (default $CLAUDE_CONFIG_DIR/.credentials.json)
    CLAUDE_THROTTLE_USAGE_URL    endpoint override (tests)
"""
import hashlib
import json
import os
import time
import urllib.error
import urllib.request
from email.utils import parsedate_to_datetime

DEFAULT_CACHE = "/tmp/claude-throttle-fable.json"
DEFAULT_URL = "https://api.anthropic.com/api/oauth/usage"
DEFAULT_TTL_S = 300.0
TIMEOUT_S = 5.0
MAX_BACKOFF_S = 3600.0
MODEL_NAME = "fable"


def env_float(name, default):
    try:
        return float(os.environ.get(name) or "")
    except ValueError:
        return default


def cache_path():
    return os.environ.get("CLAUDE_THROTTLE_FABLE_CACHE") or DEFAULT_CACHE


def credentials_path():
    explicit = os.environ.get("CLAUDE_CREDENTIALS")
    if explicit:
        return explicit
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(
        os.path.expanduser("~"), ".claude"
    )
    return os.path.join(base, ".credentials.json")


def token_fingerprint(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:16]


def read_cache(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write_cache(path, data):
    """Write via .tmp + rename so a reader never sees a half-written file."""
    tmp = "%s.tmp.%d" % (path, os.getpid())
    try:
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def read_oauth():
    try:
        with open(credentials_path()) as f:
            blob = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(blob, dict):
        return None
    oauth = blob.get("claudeAiOauth")
    return oauth if isinstance(oauth, dict) else None


def retry_after_s(headers):
    """Retry-After as seconds. Accepts both the delta and HTTP-date forms."""
    raw = headers.get("Retry-After") if headers else None
    if not raw:
        return 0.0
    raw = raw.strip()
    try:
        return min(MAX_BACKOFF_S, max(0.0, float(raw)))
    except ValueError:
        pass
    try:
        when = parsedate_to_datetime(raw).timestamp()
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return min(MAX_BACKOFF_S, max(0.0, when - time.time()))


def fetch_usage(token):
    """GET the usage payload. Returns (payload_or_None, backoff_seconds)."""
    url = os.environ.get("CLAUDE_THROTTLE_USAGE_URL") or DEFAULT_URL
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": "Bearer %s" % token,
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8")), 0.0
    except urllib.error.HTTPError as e:
        # 429 is the one status worth backing off from; everything else
        # (401 on an expired token, 5xx) just waits out the normal TTL.
        return None, retry_after_s(e.headers) if e.code == 429 else 0.0
    except (urllib.error.URLError, OSError, ValueError):
        return None, 0.0


def fable_percent(payload):
    """Pull the Fable weekly window out of a /api/oauth/usage payload.

    Returns None when the account has no Fable bucket, which is a real
    answer (hide the number), not an error.
    """
    limits = payload.get("limits") if isinstance(payload, dict) else None
    if not isinstance(limits, list):
        return None
    for item in limits:
        if not isinstance(item, dict) or item.get("kind") != "weekly_scoped":
            continue
        scope = item.get("scope")
        model = scope.get("model") if isinstance(scope, dict) else None
        name = model.get("display_name") if isinstance(model, dict) else None
        if not isinstance(name, str) or name.strip().lower() != MODEL_NAME:
            continue
        pct = item.get("percent")
        if isinstance(pct, (int, float)) and not isinstance(pct, bool):
            return float(pct)
    return None


def main():
    oauth = read_oauth()
    if not oauth:
        return
    token = oauth.get("accessToken")
    if not isinstance(token, str) or not token:
        return

    path = cache_path()
    ttl = env_float("CLAUDE_THROTTLE_FABLE_TTL", DEFAULT_TTL_S)
    now = time.time()
    fp = token_fingerprint(token)

    cached = read_cache(path)
    same_account = cached.get("token_fp") == fp
    attempted_at = cached.get("attempted_at")
    if (
        same_account
        and isinstance(attempted_at, (int, float))
        and now - attempted_at < ttl
    ):
        return  # another render already refreshed (or is backing off)

    # Stamp the attempt before the request so concurrent renders that all
    # saw the stale cache do not all fire one. Values carry over only when
    # the token still matches; after an account switch they belong to a
    # different account.
    entry = {
        "attempted_at": now,
        "fetched_at": cached.get("fetched_at") if same_account else None,
        "fable_pct": cached.get("fable_pct") if same_account else None,
        "token_fp": fp,
    }
    write_cache(path, entry)

    expires_at = oauth.get("expiresAt")  # milliseconds since epoch
    if isinstance(expires_at, (int, float)) and expires_at / 1000.0 <= now:
        return  # would just 401, and refreshing the token is not ours to do

    payload, backoff = fetch_usage(token)
    if payload is None:
        if backoff > 0:
            # Park the next attempt past the server backoff window.
            entry["attempted_at"] = now + backoff
            write_cache(path, entry)
        return

    entry["fable_pct"] = fable_percent(payload)
    entry["fetched_at"] = time.time()
    entry["attempted_at"] = entry["fetched_at"]
    write_cache(path, entry)


if __name__ == "__main__":
    main()
