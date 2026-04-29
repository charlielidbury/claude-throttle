# Claude Code Token-Pacing Throttle — Build Plan

## Goal

Pace Claude Code's rate-limit utilization against elapsed time within
the active billing windows (5-hour and 7-day), so background agents
running in interactive mode never exhaust the session limit before the
window resets.

The throttle is opt-in per session via an environment variable, so
interactive sessions in the same project are unaffected when it's not
set.

## Architecture

Two scripts and a cache file:

```
┌────────────────────┐   writes    ┌────────────────────────┐
│  statusline.sh     │ ──────────▶ │ /tmp/claude-throttle-  │
│  (statusLine cmd)  │             │ cache.json             │
│                    │             └────────────────────────┘
│  reads rate_limits │                        │
│  from stdin        │                        │ reads
│  prints status bar │                        ▼
│  text              │             ┌────────────────────────┐
└────────────────────┘             │  throttle.sh           │
                                   │  (PreToolUse hook)     │
                                   │  decides: sleep/skip   │
                                   └────────────────────────┘
```

- **`statusline.sh`** is registered as the user's `statusLine` command.
  Claude Code pipes its statusLine JSON (including `rate_limits`) to
  this script on every tick. The script writes the relevant subset
  atomically to a cache file, and prints a short visible status bar
  string ("5h:56% 7d:79%").
- **`throttle.sh`** is registered as a `PreToolUse` hook with matcher
  `*`. On every tool call, it reads the cache file, computes whether
  pacing is needed, sleeps if so, and exits 0.

This split is necessary because PreToolUse hooks do not receive
`rate_limits` in their stdin. We confirmed empirically: PreToolUse
stdin contains only `session_id`, `transcript_path`, `cwd`,
`permission_mode`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_use_id`. The `rate_limits` field is exposed only via statusLine
input.

## Data source: statusLine `rate_limits`

Claude Code v1.2.80+ pipes `rate_limits` to statusLine commands as
part of the standard payload:

```json
{
  "rate_limits": {
    "five_hour":  {"used_percentage": 56, "resets_at": 1777468800},
    "seven_day":  {"used_percentage": 79, "resets_at": 1777482000}
  }
}
```

- `used_percentage` is 0–100, the same number `/usage` shows.
- `resets_at` is a Unix epoch timestamp (seconds).
- Field is documented at <https://code.claude.com/docs/en/statusline>.
- Verified empirically: the numbers match
  `https://api.anthropic.com/api/oauth/usage` (the endpoint `/usage`
  itself queries) within sampling drift.

### Cold start and staleness

Two facts about statusLine cadence we have to design around:

1. **`rate_limits` only appears after the first API response of a
   session.** First statusLine tick has no `rate_limits` field
   (verified). The throttle hook treats missing data as "no signal,
   skip pacing".

2. **statusLine ticks fire on assistant-message updates, not on a
   timer.** During a tool-heavy turn (many bash/read/edit tool calls
   between assistant messages), the cache could be 10–60s stale.
   Utilization moves slowly enough that this is acceptable for pacing
   purposes — within a single tool-heavy turn the utilization rarely
   moves more than 1–2 percentage points.

The hook treats cache older than `MAX_CACHE_AGE_S` (default 1800s,
30 min) as missing — stale enough that it's better to fail open than
pace on old data. Originally 300s, raised after observing real-world
cadence: statusLine inter-update gaps are bimodal (bursts under 10s,
or 5-10+ min droughts during tool-heavy turns), and 5 min was
throwing away half the long gaps. Utilization moves slowly enough
that 30 min of staleness is still acceptable.

### Why not the `/api/oauth/usage` endpoint?

Considered and rejected — see `docs/rejected-endpoint-approach.md`.
Short version: undocumented internal endpoint, OAuth handling, slower
per call, and statusLine already gives us the same number. The
endpoint helper script `usage.sh` is preserved as an ad-hoc debug
tool.

## Pacing model

For each tracked window (`five_hour`, `seven_day`), define:

```
window_s        = window length in seconds (18000 for 5h, 604800 for 7d)
elapsed_s       = window_s − (resets_at − now)
util_frac       = used_percentage / 100
target_elapsed  = util_frac × window_s / CLAUDE_THROTTLE
sleep_s_window  = max(0, target_elapsed − elapsed_s)
```

The hook sleeps for `max(sleep_s_5h, sleep_s_7d)` so whichever window
is closest to its limit wins. If only one window is reported, ignore
the other.

`CLAUDE_THROTTLE` is a multiplier in (0, 1] that controls pacing
aggressiveness. It also serves as the on/off switch — if unset, empty,
zero, or non-numeric, pacing is disabled.

- `CLAUDE_THROTTLE=1.0` → use up to 100% of the limit evenly across the
  window. At 50% time elapsed, allow utilization up to 50%.
- `CLAUDE_THROTTLE=0.9` → leave 10% headroom. At 50% time elapsed,
  allow utilization up to 45%.
- `CLAUDE_THROTTLE=0.5` → conservative, half the limit per window.

Cap a single sleep at 540 seconds (9 minutes) to stay safely under the
10-minute hook timeout. If true catchup needs longer, the next tool
call will sleep again — the agent self-paces over multiple calls.

**Warmup bypass.** For each window, if `used_percentage <
WARMUP_THRESHOLD_PCT` (default 10), skip pacing for that window. Below
10% utilization the agent is well within any reasonable safety margin,
so pacing has no work to do. Avoids spurious throttles in the first
few minutes of a fresh window where the math says "ahead of pace" but
in practice means nothing.

**Worked example.** `CLAUDE_THROTTLE=0.9`, `five_hour.used_percentage=56`,
`resets_at=now+9000s` (so elapsed = 18000−9000 = 9000s, 50% of window).

- Util above 10% threshold → normal pacing.
- `target_elapsed = 0.56 × 18000 / 0.9 = 11200s`
- `sleep_s_5h = 11200 − 9000 = 2200s`, capped to 540s.

Same example with `seven_day.used_percentage=79`,
`resets_at=now+50400s` (elapsed = 604800−50400 = 554400s, 91.7% of
window):

- `target_elapsed = 0.79 × 604800 / 0.9 = 530773s`
- `sleep_s_7d = 530773 − 554400 = −23627s` → 0 (already behind pace).

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

Ships as a git repository with an `install.sh` script that merges the
required entries into `~/.claude/settings.json`. **Not a Claude Code
plugin** — the plugin manifest schema doesn't allow plugins to register
a statusLine (only `agent` is allowlisted under `settings`). Since the
throttle needs both a statusLine and a hook, settings-snippet
distribution is simpler than the plugin route.

Repo layout:

```
claude-throttle/
├── docs/
│   ├── initial-plan.md
│   └── rejected-endpoint-approach.md
├── scripts/
│   ├── statusline.sh              # statusLine writer
│   └── throttle.sh                # PreToolUse hook
├── tests/
│   ├── test-throttle.sh           # unit tests
│   └── integration-test.sh        # integration test
├── install.sh                     # merges entries into ~/.claude/settings.json
├── uninstall.sh                   # removes them
├── usage.sh                       # ad-hoc /api/oauth/usage debug helper
└── README.md
```

User flow:

```bash
git clone https://github.com/<user>/claude-throttle ~/claude-throttle
~/claude-throttle/install.sh
export CLAUDE_THROTTLE=0.9
claude
```

`install.sh` writes absolute paths into `~/.claude/settings.json` so
nothing depends on the repo being on `$PATH`.

## Components

### 1. `scripts/statusline.sh`

Responsibilities:
- Read JSON from stdin (Claude Code's statusLine payload).
- Extract `rate_limits` and current timestamp.
- Atomically write to cache file:
  ```json
  {
    "captured_at": 1777461208,
    "rate_limits": {
      "five_hour": {"used_percentage": 56, "resets_at": 1777468800},
      "seven_day": {"used_percentage": 79, "resets_at": 1777482000}
    }
  }
  ```
  `rate_limits` may be `null` on cold-start ticks.
- Print a short status string to stdout for the visible status bar
  (e.g. `5h:56% 7d:79%`).

Atomic write: write to `${CACHE_FILE}.tmp.$$` then `mv` over the real
path. Avoids the throttle hook reading a half-written file mid-update.

Cache path: `${CLAUDE_THROTTLE_CACHE:-/tmp/claude-throttle-cache.json}`.

If the user already has a statusLine they want to keep, two options:
1. They wrap our script (their statusLine calls ours and forwards the
   output), or
2. They use ours as their primary and we add features as needed.
The README will document the wrapper recipe.

### 2. `scripts/throttle.sh`

PreToolUse hook. Responsibilities:
- Exit 0 immediately if `CLAUDE_THROTTLE` is unset, empty, zero, or
  non-numeric.
- Read the cache file. If missing, exit 0 (no data, can't pace).
- If cache is older than `MAX_CACHE_AGE_S` (default 1800), exit 0.
- If `rate_limits` is null (cold start), exit 0.
- For each window (`five_hour`, `seven_day`):
  - If `used_percentage < WARMUP_THRESHOLD_PCT` (default 10), skip.
  - Else compute `sleep_s_window` per the pacing model.
- Sleep for `max(sleep_5h, sleep_7d)`, capped at `MAX_SLEEP` (default 540).
- Log every decision to `~/.claude/throttle.log`.
- After a non-zero sleep, emit a JSON object to stdout with a
  `systemMessage` field summarizing the throttle. Skip emission when
  `sleep_s == 0` to avoid transcript noise.
- On any error, log and exit 0 — never block the agent due to hook
  failure.

Inputs:
- stdin: PreToolUse JSON event (read and discarded).
- env `CLAUDE_THROTTLE`: pacing multiplier in (0, 1]. Unset, empty,
  zero, or non-numeric disables the hook.
- env `MAX_SLEEP`: cap on a single sleep (default 540).
- env `WARMUP_THRESHOLD_PCT`: utilization percent below which pacing is
  bypassed for a given window (default 10).
- env `MAX_CACHE_AGE_S`: cache freshness limit (default 1800).
- env `THROTTLE_LOG`: log file path (default `~/.claude/throttle.log`).
- env `CLAUDE_THROTTLE_CACHE`: cache file path (default
  `/tmp/claude-throttle-cache.json`).

User notification:

After sleeping (only when `sleep_s > 0`), the hook emits a JSON object
on stdout:

```json
{
  "systemMessage": "Throttle: slept 540s (5h: 56% util at 50% elapsed; 7d: 79% util at 92% elapsed; throttle=0.9)"
}
```

`systemMessage` is rendered as a warning notice in the transcript that
the user sees but is not fed back into Claude's context. Verify on the
installed Claude Code version (`/hooks` and `claude --debug`) before
relying on it; if not supported, fall back to writing the notice to
stderr (Claude Code surfaces hook stderr as a transcript notice).

Stdout discipline: only print the JSON object, and only when there was
an actual sleep. All debug logging goes to the log file or stderr,
never stdout.

### 3. `install.sh`

Idempotent installer. Responsibilities:
- Resolve absolute paths to `statusline.sh` and `throttle.sh` based on
  the script's own location.
- Read existing `~/.claude/settings.json` (or `{}` if missing).
- Back it up to `~/.claude/settings.json.backup-<timestamp>`.
- Merge in:
  ```json
  {
    "statusLine": {
      "type": "command",
      "command": "<absolute-path>/scripts/statusline.sh"
    },
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "*",
          "hooks": [
            {
              "type": "command",
              "command": "<absolute-path>/scripts/throttle.sh",
              "timeout": 600
            }
          ]
        }
      ]
    }
  }
  ```
- If the user already has a `statusLine` configured, refuse to
  overwrite without `--force`. Print instructions for the wrapper
  recipe instead.
- If the user already has hooks for `PreToolUse`, append rather than
  replace.

### 4. `uninstall.sh`

Reverses `install.sh`: removes throttle entries from
`~/.claude/settings.json`. Keeps a backup before modifying.

### 5. `tests/test-throttle.sh`, `tests/integration-test.sh`

Standalone scripts that exercise the hook without going through Claude
Code. See Test plan below.

## Implementation steps

1. **Repo skeleton.** Create directory structure shown above. Done
   except for `throttle.sh`, `install.sh`, `uninstall.sh`, and tests.

2. **Verify prerequisites.**
   - `python3` (for JSON parsing and float math).
   - Document in README.

3. **Implement `scripts/throttle.sh`.**
   - Bash, `set -euo pipefail`, but trap errors to log-and-exit-0.
   - Read cache file, validate freshness.
   - For each window, compute `elapsed_s` from `resets_at`. Skip
     windows where `resets_at` is null or missing.
   - Apply warmup bypass per window.
   - Compute `sleep_s_window` per the pacing model. Take max across
     windows. Cap at `MAX_SLEEP`.
   - Sleep, then emit `systemMessage` JSON if sleep was non-zero.
   - Always log: timestamp, both utilizations, both elapsed, sleep
     decision, warmup-bypass status.
   - Use `python3 -c` for any float math and JSON construction; do not
     hand-build JSON strings.

4. **Implement `install.sh` / `uninstall.sh`.**
   - Use `python3` to merge JSON safely (preserves user's other
     settings, handles missing keys).
   - Back up before writing.
   - Detect and refuse to clobber existing statusLine without `--force`.

5. **Write the test harnesses** (see Test plan below).

6. **Local dev test.**
   - Already configured: `.claude/settings.json` in this repo points
     to `scripts/statusline.sh`. Once `throttle.sh` exists, add a
     PreToolUse hook entry.
   - Drive an interactive session with tmux:
     `tmux new-session -d -s test -c $(pwd) 'claude --dangerously-skip-permissions'`,
     send prompts, inspect logs.

7. **End-to-end install test.**
   - On a clean machine (or after running `uninstall.sh`), run
     `install.sh`.
   - Confirm `~/.claude/settings.json` has the expected entries.
   - Run `claude` interactively, send a prompt, confirm:
     - statusLine bar shows utilization (`5h:NN% 7d:NN%`).
     - Cache file appears at `/tmp/claude-throttle-cache.json` with
       fresh `captured_at` and `rate_limits`.
     - With `CLAUDE_THROTTLE=0.5`, throttle.log shows pacing decisions.
     - With `CLAUDE_THROTTLE` unset, no log entries appear.

8. **Publish.**
   - Push to GitHub.
   - README with the install + usage flow.

## Test plan

### Unit tests for `throttle.sh`

The harness writes canned cache files at known timestamps and runs the
hook against them. Test cases:

| Case | Setup | Expected |
|------|-------|----------|
| Throttle disabled (unset) | `CLAUDE_THROTTLE` unset | Exit 0, no sleep, no cache read, no stdout |
| Throttle disabled (empty) | `CLAUDE_THROTTLE=""` | Same |
| Throttle disabled (zero) | `CLAUDE_THROTTLE=0` | Same |
| Throttle disabled (garbage) | `CLAUDE_THROTTLE=foo` | Same |
| No cache file | cache file absent | Exit 0, no sleep, log "no cache" |
| Stale cache | `captured_at = now − 600`, `MAX_CACHE_AGE_S=300` | Exit 0, no sleep, log "stale" |
| Cold start | cache present but `rate_limits=null` | Exit 0, no sleep, log "no rate_limits" |
| Warmup bypass, 5h | `five_hour.used_percentage=5`, elapsed=0s | No sleep on 5h |
| Warmup bypass even when ahead | `five_hour=7.5%`, elapsed=60s, throttle=0.5 | Sleep=0 due to bypass |
| Just over warmup | `five_hour=10.5%`, elapsed=900s | Normal pacing applies |
| Behind pace, throttle=1.0 | `five_hour=25%`, elapsed=9000s | Sleep=0 |
| On pace, throttle=1.0 | `five_hour=20%`, elapsed=3600s | Sleep ≈ 0 |
| Ahead of pace, throttle=1.0 | `five_hour=20%`, elapsed=1800s | Sleep > 0, capped at 540, stdout JSON |
| Multiplier kicks in, throttle=0.5 | `five_hour=20%`, elapsed=3600s | Sleep > 0 |
| Both windows ahead | 5h ahead by 100s, 7d ahead by 300s | Sleep = 300 |
| 7d resets_at null | `seven_day.resets_at = null` | 7d ignored, sleep based on 5h |
| Missing 7d entirely | no `seven_day` key | 7d ignored |
| Invalid cache JSON | cache contains garbage | Log error, exit 0 |
| Stdout JSON validity | any case that produces stdout | Output parses as valid JSON |

For sleep verification, override `sleep` in the test
(`sleep() { echo "SLEPT $1"; }`) so tests run instantly and capture
intended duration.

### Integration test

Drive a real Claude Code session via tmux:
1. `install.sh` into a sandbox `~/.claude` (use `HOME` override).
2. `tmux new-session -d -s test -c $(pwd) 'env CLAUDE_THROTTLE=0.1
   claude --dangerously-skip-permissions'`.
3. Send a prompt that does several tool calls.
4. After the run, verify:
   - Cache file is fresh and has `rate_limits`.
   - `~/.claude/throttle.log` shows sleeps between tool calls.
   - The `systemMessage` rendering appeared in the session transcript
     (capture pane).
5. Re-run with `CLAUDE_THROTTLE` unset, confirm no log entries.

### Manual checks

- `/hooks` inside Claude Code shows the throttle hook registered.
- `claude --debug` output mentions the hook firing on tool calls.
- `./usage.sh` returns the same numbers as the cache file.
- Stderr from either script appears as a notice in the transcript.

## Edge cases and gotchas

- **Cache file deleted mid-session.** Hook exits 0; next statusLine
  tick recreates it. Acceptable.
- **resets_at in the past.** Clock skew or stale cache. Treat as zero
  elapsed (fresh window).
- **Window boundary crossed mid-session.** When the window rolls over,
  statusLine reports new utilization and `resets_at`; pacing math
  works without special handling.
- **Multiple concurrent sessions.** All sessions write to the same
  cache file. Last-write-wins; the data is account-global anyway, so
  this is the correct semantics.
- **Parallel tool calls.** N parallel tool calls fire N hook
  invocations; they all read the same cache and decide independently.
  Total wall time is the longest sleep, not the sum.
- **Hook timeout.** If the hook is killed at the 600s timeout, Claude
  Code treats it as a non-blocking error and the tool call proceeds.
  Acceptable failure mode.
- **Don't log to stdout.** PreToolUse stdout is parsed as JSON output;
  any non-JSON could confuse Claude Code. All logging goes to file or
  stderr.
- **`set -e` and arithmetic.** Bash `(( ... ))` returning 0 with
  `set -e` exits the script. Use `|| true` or `if (( ... )); then`.
- **User has existing statusLine.** `install.sh` refuses to overwrite
  without `--force`. README documents the wrapper recipe (their
  statusLine calls ours and forwards stdout).
- **rate_limits absent for non-Claude.ai accounts.** statusLine
  payload only includes `rate_limits` for Claude.ai subscribers
  (StatusLine.tsx wraps the field in a conditional). Hook treats
  missing field as "no signal, no pacing". For API-key users the
  throttle is effectively a no-op — which is correct, since the
  5h/7d windows don't apply to them.

## Open questions

### Q1: Cache age limit

Originally 300s, raised to 1800s (30 min) after instrumenting one
session of ~4.5h real use:
- 41 distinct cache updates seen in the throttle log
- Bimodal inter-update gaps: ~35% under 10s (rendering bursts),
  ~30% in the 5–10 min range (tool-heavy turns), longest 57 min
- Median 222s, mean 400s. At 300s threshold, ~50% of long gaps
  were thrown away as stale, leaving the throttle effectively off
  during tool-heavy stretches.

30 min still excludes the truly stale outliers (the 57 min gap)
without sacrificing actionable signal. Utilization moves slowly
enough that 30 min of staleness is acceptable.

### Q2: Wrapper recipe for users with existing statusLine

For users running ccstatusline or similar, the cleanest install is a
wrapper script that calls our statusline.sh AND their existing one,
combining the outputs. Worth shipping a `wrap-statusline.sh` template.

Recommendation: ship the template in v1.1 once we see how common this
case is.

## Out of scope for v1

- Pacing per-model windows (`seven_day_opus`, `seven_day_sonnet`).
  These are in the `/api/oauth/usage` endpoint but not in statusLine
  `rate_limits`. v1 paces against the aggregate `five_hour` and
  `seven_day` only.
- Auto-resume after window exhaustion. That's `claude-auto-retry`'s job.
- Per-agent budgets when multiple agents share an account. v1 paces
  against the global utilization total.
- Pacing against `extra_usage` (paid overage credits). Not relevant
  for the limit-avoidance use case.
- Non-interactive (`claude -p`) support. statusLine doesn't fire there
  — would need the endpoint approach instead. We don't run agents in
  this mode.
