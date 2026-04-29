# Claude Code Token-Pacing Throttle Hook — Build Plan

## Goal

Build a `PreToolUse` hook that paces Claude Code's rate-limit utilization
against elapsed time within the active billing windows (5-hour and
7-day), so background agents never exhaust the session limit before the
window resets.

The hook is opt-in per session via an environment variable, so interactive
sessions in the same project are unaffected.

## Data source

Claude Code's `/usage` slash command queries an internal endpoint that
returns server-authoritative rate-limit utilization. The throttle hook
calls the same endpoint:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth_access_token>
anthropic-beta: oauth-2025-04-20
```

The OAuth access token lives at `~/.claude/.credentials.json` under
`.claudeAiOauth.accessToken`. Claude Code refreshes it on its own as
part of normal use; the hook just reads whatever is on disk.

Response shape (relevant fields):

```json
{
  "five_hour": {"utilization": 55.0, "resets_at": "2026-04-29T13:20:00+00:00"},
  "seven_day": {"utilization": 79.0, "resets_at": "2026-04-29T17:00:00+00:00"},
  "seven_day_opus":   {"utilization": 0.0, "resets_at": null},
  "seven_day_sonnet": {"utilization": 0.0, "resets_at": null},
  "extra_usage": {"is_enabled": false, "monthly_limit": null, ...}
}
```

`utilization` is a 0–100 percentage of the corresponding window's limit.
`resets_at` is the ISO 8601 timestamp at which the window rolls over;
`null` means the window hasn't started accruing yet.

This eliminates the need for `TOKEN_BUDGET` and removes the dependency
on `ccusage` and JSONL parsing. The number we pace against is the same
number the user sees in `/usage`.

A small helper script `usage.sh` at the repo root prints this JSON for
ad-hoc inspection — useful for sanity-checking the throttle.

### Stability caveats

The endpoint is internal and undocumented. Schema or path changes would
break the hook silently. Mitigations:

- Validate response shape before using it; on schema mismatch, log and
  fail soft (exit 0, don't block).
- On HTTP 401 (token expired or revoked), fail soft. Claude Code itself
  refreshes the token on its next call, so subsequent hook invocations
  recover automatically.
- On any network error or non-2xx, fail soft.

## Pacing model

For each tracked window (5-hour, 7-day), define:

```
window_s        = window length in seconds (18000 for 5h, 604800 for 7d)
elapsed_s       = window_s − (resets_at − now)
util_frac       = utilization / 100
target_elapsed  = util_frac × window_s / CLAUDE_THROTTLE
sleep_s_window  = max(0, target_elapsed − elapsed_s)
```

The hook sleeps for `max(sleep_s_5h, sleep_s_7d)` so whichever window
is closest to its limit wins. If only one window is reported (e.g.
`seven_day.resets_at` is null because there's been no recent activity),
ignore that window.

`CLAUDE_THROTTLE` is a multiplier in (0, 1] that controls pacing
aggressiveness. It also serves as the on/off switch — if unset, empty,
zero, or non-numeric, pacing is disabled.

- `CLAUDE_THROTTLE=1.0` → use up to 100% of the limit evenly across the
  window. At 50% time elapsed, allow utilization up to 50%.
- `CLAUDE_THROTTLE=0.9` → leave 10% headroom. At 50% time elapsed, allow
  utilization up to 45%.
- `CLAUDE_THROTTLE=0.5` → conservative, half the limit per window.

Cap a single sleep at 540 seconds (9 minutes) to stay safely under the
10-minute hook timeout. If true catchup needs longer, the next tool call
will sleep again — the agent self-paces over multiple calls.

**Warmup bypass.** For each window, if `utilization < WARMUP_THRESHOLD_PCT`
(default 10), skip pacing for that window. This avoids:

1. Spurious throttles in the first few minutes of a fresh window where
   1% utilization at 0.1% elapsed-time looks "ahead of pace" by the math
   but in practice means nothing.
2. Division-by-zero / noise when both numbers are near zero.

Below 10% utilization the agent is well within any reasonable safety
margin, so pacing has no work to do. Above 10%, normal pacing kicks in.

**Worked example.** `CLAUDE_THROTTLE=0.9`, `five_hour.utilization=55`,
`resets_at=now+9000s` (so elapsed = 18000−9000 = 9000s, 50% of window).

- Util above 10% threshold → normal pacing.
- `target_elapsed = 0.55 × 18000 / 0.9 = 11000s`
- `sleep_s_5h = 11000 − 9000 = 2000s`, capped to 540s.

Same example for the 7-day window with `seven_day.utilization=79`,
`resets_at=now+50400s` (elapsed = 604800−50400 = 554400s, 91.7% of
window):

- `target_elapsed = 0.79 × 604800 / 0.9 = 530773s`
- `sleep_s_7d = 530773 − 554400 = −23627s` → 0 (already behind pace on 7d).

Final sleep = `max(540, 0) = 540s`. Hook sleeps for 9 minutes, emits
the systemMessage, and exits 0.

## Activation

The hook only paces when `CLAUDE_THROTTLE` is set to a positive number.
If unset, empty, zero, or non-numeric, the hook exits 0 immediately
(no-op).

Background-agent launch:

```bash
CLAUDE_THROTTLE=0.9 claude
```

Interactive launch (no env var, hook is a no-op):

```bash
claude
```

## Distribution

The hook ships as a Claude Code plugin distributed via a marketplace
git repo. Users install with:

```
/plugin marketplace add charlielidbury/claude-throttle
/plugin install throttle@claude-throttle
```

(Repo and plugin names are placeholders — fill in the real ones.)

Plugins live in Claude Code's cache directory after install
(`~/.claude/plugins/cache/...`) and update via `/plugin marketplace update`.
This means:

- No manual editing of `settings.json` for users.
- Hook script lives inside the plugin directory, not in the user's
  project. Reference it via `${CLAUDE_PLUGIN_ROOT}` in the hooks config.
- One install, works in all projects (no per-project setup).
- Updates propagate via the marketplace — users get fixes without re-cloning.

The repo layout follows the standard Claude Code plugin convention:

```
claude-throttle/                          # repo root = marketplace
├── .claude-plugin/
│   └── marketplace.json                  # marketplace manifest
├── plugins/
│   └── throttle/                         # the plugin
│       ├── .claude-plugin/
│       │   └── plugin.json               # plugin manifest
│       ├── hooks/
│       │   └── hooks.json                # hook registration
│       ├── scripts/
│       │   └── throttle.sh               # the hook script
│       ├── tests/
│       │   ├── test-throttle.sh          # unit tests
│       │   └── integration-test.sh       # integration test
│       └── README.md
├── usage.sh                              # ad-hoc usage probe
└── README.md                             # repo-level readme for GitHub
```

## Components

### 1. The hook script: `scripts/throttle.sh`

Responsibilities:

- Exit 0 immediately if `CLAUDE_THROTTLE` is unset, empty, zero, or
  non-numeric.
- Read OAuth access token from `~/.claude/.credentials.json`.
- `GET /api/oauth/usage` with the Bearer token and beta header.
- Validate response shape; on any failure (network, non-2xx, schema),
  log and exit 0.
- For each tracked window (`five_hour`, `seven_day`):
  - If utilization < `WARMUP_THRESHOLD_PCT` (default 10), skip.
  - Else compute `sleep_s_window` per the pacing model.
- Sleep for `max(sleep_s_5h, sleep_s_7d)`, capped at `MAX_SLEEP` (default 540).
- Log every decision to `~/.claude/throttle.log`.
- After a non-zero sleep, emit a JSON object to stdout with a
  `systemMessage` field summarizing the throttle (see below). Skip
  emission when `sleep_s == 0` to avoid transcript noise.
- On any error (no token, network failure, JSON parse fail, etc.), log
  and exit 0 — never block the agent due to hook failure.

Cache layer: store the most recent `/usage` response at
`/tmp/claude-throttle-cache.json` with a `CACHE_TTL_S` (default 30)
expiry. Utilization moves slowly enough that 30s staleness is
indistinguishable from live, and this avoids hammering the endpoint on
tool-heavy turns.

Inputs:
- stdin: PreToolUse JSON event from Claude Code (read and discarded).
- env `CLAUDE_THROTTLE`: pacing multiplier in (0, 1]. Unset, empty,
  zero, or non-numeric disables the hook.
- env `MAX_SLEEP`: cap on a single sleep (default 540).
- env `WARMUP_THRESHOLD_PCT`: utilization percent below which pacing is
  bypassed for a given window (default 10). Set to 0 to disable.
- env `CACHE_TTL_S`: cache lifetime for the `/usage` response (default 30).
- env `THROTTLE_LOG`: log file path (default `~/.claude/throttle.log`).
- env `CLAUDE_CREDENTIALS`: path to credentials file (default
  `~/.claude/.credentials.json`).

User notification:

After sleeping (only when `sleep_s > 0`), the hook emits a JSON object
on stdout:

```json
{
  "systemMessage": "Throttle: slept 540s (5h: 55% util at 50% elapsed; 7d: 79% util at 92% elapsed; throttle=0.9)"
}
```

`systemMessage` is rendered as a warning notice in the transcript that
the user sees but is not fed back into Claude's context. This means:

- The user gets visibility into when and why pacing kicked in, scrollable
  in the session transcript without leaving the agent.
- Claude itself doesn't see the message and doesn't spend tokens reading
  about its own pacing — important since the whole point is to conserve
  tokens.

Do **not** use `additionalContext` for this. That field would inject the
throttle info into Claude's context, which both wastes tokens and risks
the agent reasoning about pacing in unhelpful ways.

Stdout discipline: only print the JSON object, and only when there was
an actual sleep. Any other stdout content on a `PreToolUse` hook is
parsed as JSON output and could confuse Claude Code if malformed. All
debug logging goes to the log file or stderr, never stdout.

Verify before relying on it: confirm `systemMessage` is the right output
field for `PreToolUse` hooks against the installed Claude Code version
(`/hooks` and `claude --debug`). If not supported on PreToolUse, fall
back to writing the notice to stderr (Claude Code surfaces hook stderr
as a transcript notice).

### 2. Plugin manifest: `.claude-plugin/plugin.json`

Standard plugin metadata:

```json
{
  "name": "throttle",
  "version": "0.1.0",
  "description": "Pace Claude Code rate-limit utilization against elapsed time within billing windows",
  "author": "your-name",
  "homepage": "https://github.com/your-user/claude-throttle"
}
```

### 3. Marketplace manifest: `.claude-plugin/marketplace.json`

Top-level catalog so the repo can be added with `/plugin marketplace add`:

```json
{
  "name": "claude-throttle",
  "owner": "your-name",
  "description": "Rate-limit-aware throttle for Claude Code background agents",
  "plugins": [
    {
      "name": "throttle",
      "source": "./plugins/throttle"
    }
  ]
}
```

### 4. Hook registration: `hooks/hooks.json`

Registers the throttle hook on `PreToolUse` with matcher `*`. Use
`${CLAUDE_PLUGIN_ROOT}` to reference the script — this resolves to the
plugin's cache location at runtime:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/throttle.sh",
            "timeout": 600
          }
        ]
      }
    ]
  }
}
```

`timeout: 600` allows the full 540s sleep window with margin.

### 5. Test harnesses: `tests/test-throttle.sh`, `tests/integration-test.sh`

Standalone scripts that exercise the hook without going through Claude
Code. See Test plan below.

## Implementation steps

1. **Set up the repo skeleton.**
   - Create the directory structure shown under "Distribution".
   - Initialise git, push to GitHub. Repo can be public from day one.

2. **Verify prerequisites.**
   - `curl` and `python3` (or `jq`) for HTTP and JSON parsing.
   - `~/.claude/.credentials.json` exists and contains
     `claudeAiOauth.accessToken` (true for any user logged in via
     Claude Pro/Max).
   - Document these in the README.

3. **Write `scripts/throttle.sh`.**
   - Bash, `set -euo pipefail` at the top, but trap errors to log-and-exit-0.
   - Read access token from credentials file (path overridable via env).
   - `GET /api/oauth/usage`. Check HTTP status, parse JSON, validate
     shape (presence of `five_hour` / `seven_day` objects with numeric
     `utilization` and ISO `resets_at` or null).
   - Implement TTL cache at `/tmp/claude-throttle-cache.json`.
   - For each window, compute `elapsed_s` from `resets_at`. Skip windows
     where `resets_at` is null.
   - Apply warmup bypass per window.
   - Compute `sleep_s_window` per the pacing model. Take max across
     windows. Cap at `MAX_SLEEP`.
   - Sleep, then emit `systemMessage` JSON if sleep was non-zero.
   - Always log: timestamp, utilization (5h, 7d), elapsed (5h, 7d),
     sleep decision, warmup-bypass status.
   - Use `python3 -c` for any float math and JSON construction; do not
     hand-build JSON strings.

4. **Write the manifests** (`plugin.json`, `marketplace.json`, `hooks.json`)
   per the templates in Components above.

5. **Write the test harnesses** (see Test plan below).

6. **Local plugin development test.**
   - Test the plugin without publishing using `claude --plugin-dir ./plugins/throttle`.
   - Confirm `/hooks` shows the throttle hook registered.
   - Confirm `claude --debug` output shows the hook firing on tool calls.

7. **Smoke test in a real session.**
   - With the plugin loaded via `--plugin-dir`, launch with
     `CLAUDE_THROTTLE=0.5 claude --plugin-dir ./plugins/throttle` (low
     multiplier so pacing kicks in fast given current real utilization).
   - Run a few tool calls.
   - Tail `~/.claude/throttle.log` and verify sleeps are happening.
   - Launch without `CLAUDE_THROTTLE` set, verify zero pacing overhead
     (no log entries, no sleeps).
   - Launch with `CLAUDE_THROTTLE=1.0` and confirm less-aggressive
     throttling than the 0.5 run.

8. **Publish to marketplace.**
   - Push the repo to GitHub.
   - Add to a personal marketplace test: `/plugin marketplace add ./path`.
   - Once verified, others can install via `/plugin marketplace add user/repo`.

## Test plan

### Unit tests for `throttle.sh`

The test harness should mock the `/usage` endpoint by replacing `curl`
(or an intermediate fetch function) with a stub that emits canned JSON.
Test cases:

| Case | Setup | Expected |
|------|-------|----------|
| Throttle disabled (unset) | `CLAUDE_THROTTLE` unset | Exit 0, no sleep, no fetch, no stdout |
| Throttle disabled (empty) | `CLAUDE_THROTTLE=""` | Exit 0, no sleep, no fetch, no stdout |
| Throttle disabled (zero) | `CLAUDE_THROTTLE=0` | Exit 0, no sleep, no fetch, no stdout |
| Throttle disabled (garbage) | `CLAUDE_THROTTLE=foo` | Exit 0, no sleep, no fetch, no stdout |
| Warmup bypass, 5h | `five_hour.utilization=5`, elapsed=0s | Exit 0, no sleep on 5h, log shows "warmup bypass" |
| Warmup bypass, 7d | `seven_day.utilization=5`, elapsed=anything | Exit 0, no sleep on 7d |
| Warmup bypass even when ahead | `five_hour.utilization=7.5`, elapsed=60s, throttle=0.5 | Without bypass would sleep; with bypass exits 0 |
| Just over warmup | `five_hour.utilization=10.5`, elapsed=900s | Normal pacing applies |
| Custom warmup threshold | `WARMUP_THRESHOLD_PCT=0`, util=0.001, elapsed=0s | Bypass disabled; should not crash on near-zero division |
| Behind pace, throttle=1.0 | util=25, elapsed=9000s (50% of 5h) | Exit 0, sleep=0, no stdout |
| On pace, throttle=1.0 | util=20, elapsed=3600s (20% of 5h) | Sleep ≈ 0 |
| Ahead of pace, throttle=1.0 | util=20, elapsed=1800s (10% of 5h) | Sleep > 0, capped at 540, stdout JSON |
| Multiplier kicks in early, throttle=0.5 | util=20, elapsed=3600s | At 1.0 this is on-pace; at 0.5 it's ahead — sleep > 0 |
| Both windows ahead | 5h ahead by 100s, 7d ahead by 300s | Sleep = 300 (max of the two) |
| 7d resets_at null | `seven_day.resets_at = null` | 7d ignored; sleep based on 5h only |
| HTTP 401 | mock returns 401 | Log error, exit 0, no stdout |
| HTTP 5xx | mock returns 500 | Log error, exit 0, no stdout |
| Network failure | curl exits non-zero | Log error, exit 0, no stdout |
| Invalid JSON | mock returns garbage | Log error, exit 0, no stdout |
| Missing fields | response without `five_hour` | Log error, exit 0, no stdout |
| Cache hit | cache file < TTL old | No fetch, decision derived from cache |
| Cache miss (expired) | cache file > TTL old | Fetch, update cache |
| No credentials file | unset/missing creds path | Log error, exit 0, no stdout |
| Stdout JSON validity | any case that produces stdout | Output parses as valid JSON; `systemMessage` is a non-empty string |

For sleep verification, override the `sleep` builtin in the test (e.g.
`sleep() { echo "SLEPT $1"; }`) so tests run instantly and capture the
intended sleep duration.

For stdout verification, capture stdout separately from stderr and pipe
through `python3 -m json.tool` (or `jq -e .`) to confirm valid JSON
when expected, or assert empty when not expected.

### Integration test

A second harness script that:
1. Launches `claude -p "run ls then date then pwd" --dangerously-skip-permissions`
   with `CLAUDE_THROTTLE=0.1` (low multiplier so even normal utilization
   triggers a sleep).
2. Times the run.
3. Verifies `~/.claude/throttle.log` shows sleeps between tool calls.
4. Verifies the `claude -p` stdout contains throttle warning notices
   (the `systemMessage` rendering) at least once.
5. Re-runs without `CLAUDE_THROTTLE` and confirms it's much faster, the
   log shows no new entries, and no throttle notices appear in output.

### Manual checks

- `/hooks` inside Claude Code shows the throttle hook registered.
- `claude --debug` output mentions the hook firing on tool calls.
- `./usage.sh` returns the same JSON the hook is reading.
- Stderr from the hook (if any) appears as a `<hook name> hook error`
  notice in the transcript — should never happen in normal operation.

## Edge cases and gotchas

- **resets_at is null.** Window hasn't accrued usage yet (e.g. cold
  start). Skip that window.
- **resets_at in the past.** Clock skew or a stale cached response. Treat
  as zero elapsed (fresh window).
- **Window boundary.** When the active window rolls over, `utilization`
  resets and `resets_at` advances. The pacing math still works without
  special handling.
- **Multiple concurrent sessions / agents.** The endpoint reports a
  global utilization for the account. Multiple background agents pacing
  off the same number is exactly the behavior we want.
- **Parallel tool calls in a single session.** N parallel tool calls fire
  N hook invocations; each reads the same cached utilization and decides
  to sleep concurrently. Wall time is the longest sleep, not the sum.
  Acceptable.
- **Hook timeout.** If the hook is killed at the 600s timeout, Claude
  Code treats it as a non-blocking error and the tool call proceeds.
  Acceptable failure mode (worst case: one un-paced tool call).
- **Token expired.** Hook 401s, fails soft. Next `claude` invocation
  refreshes the token; subsequent hook invocations recover.
- **Don't log to stdout.** PreToolUse stdout is parsed as JSON output;
  any non-JSON stdout could confuse Claude Code. Log to a file or stderr.
- **`set -e` and arithmetic.** Bash `(( ... ))` returning 0 with `set -e`
  exits the script. Use `|| true` or `if (( ... )); then`.
- **Endpoint stability.** Internal/undocumented. If the path or schema
  changes, validate-and-fail-soft means the hook turns into a no-op
  rather than blocking the agent. Log loudly so the user notices.

## Deliverables

A public git repository (e.g. `github.com/your-user/claude-throttle`)
containing:

1. `.claude-plugin/marketplace.json` — top-level marketplace catalog.
2. `plugins/throttle/.claude-plugin/plugin.json` — plugin manifest.
3. `plugins/throttle/hooks/hooks.json` — hook registration.
4. `plugins/throttle/scripts/throttle.sh` — the hook itself, executable.
5. `plugins/throttle/tests/test-throttle.sh` — unit test harness.
6. `plugins/throttle/tests/integration-test.sh` — integration test harness.
7. `plugins/throttle/README.md` — plugin README documenting:
   - Prerequisites: `curl`, `python3` (for JSON parsing and float math).
   - How to install: `/plugin marketplace add user/claude-throttle`
     then `/plugin install throttle@claude-throttle`.
   - How to enable: `export CLAUDE_THROTTLE=0.9` (or any value in (0, 1])
     before `claude`. Lower values are more conservative.
   - Recommended starting values: `0.9` for normal background use,
     `0.5` for very conservative pacing, `1.0` for even-pacing only.
   - How to tune: `MAX_SLEEP`, `WARMUP_THRESHOLD_PCT`, `CACHE_TTL_S`.
   - Where logs go.
   - How to disable temporarily: `unset CLAUDE_THROTTLE` (or set it to
     `0`, empty, or any non-numeric value).
   - How to uninstall: `/plugin uninstall throttle@claude-throttle`.
8. `usage.sh` — repo-root helper that prints raw `/usage` JSON.
9. `README.md` at repo root — short overview, links to plugin docs,
   install instructions for the marketplace.

## Open questions

### Q1: Endpoint stability commitment

The `/api/oauth/usage` endpoint is the same one `/usage` calls
internally. It works today but is undocumented. For internal/personal
use this is fine; for a public marketplace plugin, worth a conversation
with whoever owns the surface about: (a) stability expectations, (b)
whether a documented public equivalent (or a `claude --usage` flag, see
GH#20399) is on the roadmap, (c) preferred user-agent / identification
so traffic from the plugin is distinguishable from `/usage` traffic.

If a documented surface ships, switch to it. Until then, validate-and-
fail-soft on schema mismatch is the safety net.

### Q2: Cache strategy

Whether 30s TTL is the right default.

- **Lower (e.g. 5s)** — fresher data, but on tool-heavy turns the hook
  could fire several times per second. Mostly redundant.
- **Higher (e.g. 60-120s)** — fewer requests, but a burst inside a
  cache window could push utilization meaningfully past target before
  the hook notices.

Recommendation: 30s default, configurable via `CACHE_TTL_S`. Revisit
once we have real-world throughput numbers.

## Out of scope for v1

- Pacing per-model windows (`seven_day_opus`, `seven_day_sonnet`)
  separately. v1 paces against the aggregate `five_hour` and
  `seven_day` only. Per-model can come later if needed.
- Auto-resume after window exhaustion. That's `claude-auto-retry`'s job.
- Per-agent budgets when multiple background agents share an account.
  v1 paces against the global utilization total; per-agent allocation
  can come later if needed.
- Pacing against `extra_usage` (paid overage credits). Not relevant for
  the limit-avoidance use case.
