# Claude Code Token-Pacing Throttle Hook — Build Plan

## Goal

Build a `PreToolUse` hook that paces Claude Code's token consumption against
elapsed time within the 5-hour billing window, so background agents never
exhaust the session limit before the window resets.

The hook is opt-in per session via an environment variable, so interactive
sessions in the same project are unaffected.

## Pacing model

Claude Code uses 5-hour billing windows. Within a window we want token
consumption to stay below the chosen fraction of the time-elapsed
fraction:

```
tokens_consumed / token_budget  ≤  CLAUDE_THROTTLE × (elapsed_seconds / 18000)
```

`CLAUDE_THROTTLE` is a multiplier in (0, 1] that controls how aggressive
the pacing is. It also serves as the on/off switch — if it's unset (or
zero), pacing is disabled.

- `CLAUDE_THROTTLE=1.0` → use up to 100% of the budget evenly across the
  window. At 50% time elapsed, allow up to 50% of tokens.
- `CLAUDE_THROTTLE=0.9` → use up to 90% of the budget evenly. At 50%
  time elapsed, allow up to 45% of tokens. Leaves 10% headroom.
- `CLAUDE_THROTTLE=0.5` → conservative, half the budget per window.

Define `pace_ratio = (tokens_consumed / token_budget) / (CLAUDE_THROTTLE × elapsed / 18000)`.

- `pace_ratio < 1.0` → behind pace, run immediately
- `pace_ratio = 1.0` → on pace
- `pace_ratio > 1.0` → ahead of pace, sleep before allowing the tool call

When ahead of pace, sleep for long enough that pace_ratio returns to ~1.0.
The required sleep is the time it takes for the scaled elapsed-fraction
to catch up to the tokens-fraction:

```
target_elapsed = (tokens_consumed / token_budget) × 18000 / CLAUDE_THROTTLE
sleep_seconds  = max(0, target_elapsed - elapsed)
```

Cap sleep at 540 seconds (9 minutes) to stay safely under the 10-minute
hook timeout. If true catchup needs longer, the next tool call will sleep
again — the agent self-paces over multiple calls.

**Warmup bypass.** If `tokens_consumed / token_budget < 0.10`, never
throttle — exit 0 immediately regardless of elapsed time. This avoids
two problems:

1. Division-by-zero or noisy ratios at the very start of a window when
   both tokens and elapsed are near zero.
2. Spurious throttles in the first few minutes of a fresh window. A
   500-token tool call 30 seconds into a window registers as 0.25%
   tokens / 0.17% time = pace ratio 1.5, which the math says is "ahead"
   but in practice means nothing — the agent has barely started.

Below 10% of budget the agent is well within any reasonable safety
margin, so pacing has no work to do. Above 10%, normal pacing kicks in.

Worked example: `CLAUDE_THROTTLE=0.9`, `TOKEN_BUDGET=200000`,
`tokens_consumed=50000`, `elapsed=1800s` (10% of window).
- Token fraction: 25%, above warmup threshold → normal pacing applies.
- Target time fraction: 25% / 0.9 = 27.8%.
- target_elapsed = 0.278 × 18000 = 5004s.
- sleep_seconds = 5004 - 1800 = 3204s, capped to 540s.

## Activation

The hook only paces when `CLAUDE_THROTTLE` is set to a positive number.
If unset, empty, zero, or non-numeric, the hook exits 0 immediately
(no-op). The numeric value is the budget-fraction multiplier described
above.

Background-agent launch:

```bash
CLAUDE_THROTTLE=0.9 TOKEN_BUDGET=200000 claude
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

(Repo name and plugin name are placeholders — fill in the real ones.)

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
└── README.md                             # repo-level readme for GitHub
```

## Components

### 1. The hook script: `scripts/throttle.sh`

Responsibilities:

- Exit 0 immediately if `CLAUDE_THROTTLE` is unset, empty, zero, or
  non-numeric (treat any of these as "throttling disabled").
- Read current 5-hour block state from `ccusage blocks --json`.
- If `tokens_consumed / token_budget < WARMUP_THRESHOLD` (default 0.10),
  exit 0 without throttling — the agent has barely started, no pacing
  needed. Log this decision so it's visible in the throttle log.
- Otherwise, compute pace ratio and required sleep using the multiplier.
- Sleep (capped at 540s), then exit 0.
- Log every decision to `~/.claude/throttle.log` for inspection.
- After a non-zero sleep, emit a JSON object to stdout with a
  `systemMessage` field summarizing the throttle (see "User notification"
  below). Skip emission when `sleep_seconds == 0` to avoid transcript noise.
- On any error (ccusage missing, JSON parse fail, etc.), log and exit 0
  — never block the agent due to hook failure.

Inputs:
- stdin: PreToolUse JSON event from Claude Code (not actually needed for
  the pacing decision, but read and discarded so the hook is a clean
  command-type hook).
- env `CLAUDE_THROTTLE`: budget-fraction multiplier in (0, 1]. Unset,
  empty, zero, or non-numeric disables the hook. Values >1 are accepted
  but unusual (would let the agent burn through budget faster than
  evenly-paced — defeats the point but isn't an error).
- env `TOKEN_BUDGET`: per-window token budget (default 200_000).
- env `WINDOW_SECONDS`: window length (default 18000 = 5h).
- env `MAX_SLEEP`: cap on a single sleep (default 540).
- env `WARMUP_THRESHOLD`: token-fraction below which throttling is
  bypassed (default 0.10). Set to 0 to disable the warmup bypass.
- env `THROTTLE_LOG`: log file path (default `~/.claude/throttle.log`).

User notification:

After sleeping (only when `sleep_seconds > 0`), the hook emits a JSON
object on stdout:

```json
{
  "systemMessage": "Throttle: slept 240s (pace 1.34, tokens 67k/110k, elapsed 28% of window, throttle=0.9)"
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

### 2. Plugin manifest: `.claude-plugin/plugin.json`

Standard plugin metadata:

```json
{
  "name": "throttle",
  "version": "0.1.0",
  "description": "Pace Claude Code token consumption against elapsed time within the 5-hour billing window",
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
  "description": "Token-pacing throttle for Claude Code background agents",
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

2. **Verify ccusage is installed and works.**
   - `which ccusage` returns a path.
   - `ccusage blocks --json` returns valid JSON with at least one block.
   - If absent, install: `npm install -g ccusage`.
   - Document this as a prerequisite in the README. The hook will check
     at runtime and fail soft (log + exit 0) if missing.

3. **Write `scripts/throttle.sh`.**
   - Bash, `set -euo pipefail` at the top, but trap errors to log-and-exit-0.
   - Use `jq` to parse ccusage output. Verify `jq` is installed.
   - Identify the active block from the JSON (the one with `isActive: true`
     or matching status — confirm field name by inspecting actual ccusage
     output before coding against it).
   - Extract `totalTokens` and `startTime` from the active block.
   - Compute elapsed seconds: `now_epoch - start_epoch`.
   - Check warmup bypass: if `tokens / budget < WARMUP_THRESHOLD`, log
     and exit 0 without further computation.
   - Compute `target_elapsed` and `sleep_seconds` as in the pacing model.
   - Cap and sleep.
   - Always log: timestamp, tokens, elapsed, pace_ratio, sleep_decision
     (and warmup-bypass status when applicable).
   - If a sleep occurred, emit the `systemMessage` JSON object to stdout
     after the sleep completes. Use `jq -n` or `printf` with proper
     escaping; do not hand-build JSON strings.

4. **Write the manifests** (`plugin.json`, `marketplace.json`, `hooks.json`)
   per the templates in Components above.

5. **Write the test harnesses** (see Test plan below).

6. **Local plugin development test.**
   - Test the plugin without publishing using `claude --plugin-dir ./plugins/throttle`.
   - Confirm `/hooks` shows the throttle hook registered.
   - Confirm `claude --debug` output shows the hook firing on tool calls.

7. **Smoke test in a real session.**
   - With the plugin loaded via `--plugin-dir`, launch with
     `CLAUDE_THROTTLE=0.5 TOKEN_BUDGET=10000 claude --plugin-dir ./plugins/throttle`
     (low multiplier and small budget so pacing kicks in fast).
   - Run a few tool calls.
   - Tail `~/.claude/throttle.log` and verify sleeps are happening.
   - Launch without `CLAUDE_THROTTLE` set, verify zero pacing overhead
     (no log entries, no sleeps).
   - Launch with `CLAUDE_THROTTLE=1.0 TOKEN_BUDGET=10000` and confirm
     less-aggressive throttling than the 0.5 run.

8. **Publish to marketplace.**
   - Push the repo to GitHub.
   - Add to a personal marketplace test: `/plugin marketplace add ./path`.
   - Once verified, others can install via `/plugin marketplace add user/repo`.

## Test plan

### Unit tests for `throttle.sh`

The test harness should mock `ccusage` by replacing it with a function
that emits canned JSON. Test cases:

| Case | Setup | Expected |
|------|-------|----------|
| Throttle disabled (unset) | `CLAUDE_THROTTLE` unset | Exit 0, no sleep, no ccusage call, no stdout |
| Throttle disabled (empty) | `CLAUDE_THROTTLE=""` | Exit 0, no sleep, no ccusage call, no stdout |
| Throttle disabled (zero) | `CLAUDE_THROTTLE=0` | Exit 0, no sleep, no ccusage call, no stdout |
| Throttle disabled (garbage) | `CLAUDE_THROTTLE=foo` | Exit 0, no sleep, no ccusage call, no stdout |
| Warmup bypass | tokens=5000, budget=200000 (2.5%), elapsed=0s | Exit 0, no sleep, log shows "warmup bypass", no stdout |
| Warmup bypass even when ahead | tokens=15000, budget=200000 (7.5%), elapsed=60s, throttle=0.5 | Without bypass would sleep; with bypass exits 0 cleanly |
| Just over warmup | tokens=21000, budget=200000 (10.5%), elapsed=900s | Normal pacing applies, computes pace ratio |
| Custom warmup threshold | `WARMUP_THRESHOLD=0`, tokens=1, budget=200000, elapsed=0s | Bypass disabled; should not crash on near-zero division |
| Behind pace, throttle=1.0 | tokens=50000, budget=200000 (25%), elapsed=9000s (50% time) | Exit 0, sleep_seconds=0, no stdout |
| On pace, throttle=1.0 | tokens=40000, budget=200000 (20%), elapsed=3600s (20% time) | Exit 0, sleep ≈ 0, no stdout |
| Ahead of pace, throttle=1.0 | tokens=40000, budget=200000 (20%), elapsed=1800s (10% time) | Sleep > 0 capped at 540, stdout JSON with `systemMessage` |
| Multiplier kicks in early, throttle=0.5 | tokens=40000, budget=200000 (20%), elapsed=3600s (20% time) | At throttle=1.0 this is on-pace; at 0.5 it's ahead — sleep > 0 |
| Multiplier strict, throttle=0.9 (boundary) | tokens=45000, budget=200000 (22.5%), elapsed=9000s (50% time) | At threshold — sleep ≈ 0 (within 0.9 budget) |
| Multiplier strict, throttle=0.9 (over) | tokens=46000, budget=200000 (23%), elapsed=9000s (50% time) | Sleep > 0 (just over the 22.5% threshold) |
| ccusage missing | mock `which ccusage` to fail | Log error, exit 0 (don't block), no stdout |
| ccusage returns no active block | empty blocks array | Log warning, exit 0, no stdout |
| Invalid JSON from ccusage | mock returns garbage | Log error, exit 0, no stdout |
| Zero tokens consumed | tokens=0, elapsed=anything | Warmup bypass triggers, exit 0, no sleep |
| Stdout JSON validity | any case that produces stdout | Output parses as valid JSON; `systemMessage` is a non-empty string |

For sleep verification, override the `sleep` builtin in the test (e.g.
`sleep() { echo "SLEPT $1"; }`) so tests run instantly and capture the
intended sleep duration.

For stdout verification, capture stdout separately from stderr and pipe
through `jq -e .` to confirm valid JSON when expected, or assert empty
when not expected.

### Integration test

A second harness script that:
1. Launches `claude -p "run ls then date then pwd" --dangerously-skip-permissions`
   with `CLAUDE_THROTTLE=0.5 TOKEN_BUDGET=500` (low multiplier, tiny budget).
2. Times the run.
3. Verifies `~/.claude/throttle.log` shows sleeps between tool calls.
4. Verifies the `claude -p` stdout contains throttle warning notices
   (the `systemMessage` rendering) at least once.
5. Re-runs without `CLAUDE_THROTTLE` and confirms it's much faster, the
   log shows no new entries, and no throttle notices appear in output.

### Manual checks

- `/hooks` inside Claude Code shows the throttle hook registered.
- `claude --debug` output mentions the hook firing on tool calls.
- Stderr from the hook (if any) appears as a `<hook name> hook error`
  notice in the transcript — this should never happen in normal operation.

## Edge cases and gotchas

- **No active block.** If ccusage shows no active 5-hour block (cold
  start, no recent activity), there's nothing to pace against. Exit 0.
- **Block boundary.** When the active block rolls over to a new window,
  `tokens_consumed` resets and `elapsed` resets. The pacing math still
  works without special handling.
- **Multiple concurrent sessions.** ccusage aggregates across all sessions
  in the active block. If two background agents both run with the hook,
  they'll pace against the shared total — which is what we want.
- **Hook timeout.** If the hook is killed at the 600s timeout, Claude Code
  treats it as a non-blocking error and the tool call proceeds. This is
  acceptable failure mode (worst case: one un-paced tool call).
- **Don't log to stdout.** PreToolUse stdout is parsed as JSON output; any
  non-JSON stdout could confuse Claude Code. Log to a file or stderr.
- **`set -e` and arithmetic.** Bash `(( ... ))` returning 0 with `set -e`
  exits the script. Use `|| true` or `if (( ... )); then`.
- **ccusage JSON schema.** Confirm field names (`isActive`, `totalTokens`,
  `startTime`) match the installed version before hardcoding. Run
  `ccusage blocks --json | jq .` once and adjust.

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
   - Prerequisites: `jq`, `ccusage` (link to install), `bc`.
   - How to install: `/plugin marketplace add user/claude-throttle`
     then `/plugin install throttle@claude-throttle`.
   - How to enable: `export CLAUDE_THROTTLE=0.9` (or any value in (0, 1])
     before `claude`. Lower values are more conservative.
   - Recommended starting values: `0.9` for normal background use,
     `0.5` for very conservative pacing, `1.0` for even-pacing only.
   - How to tune: `TOKEN_BUDGET`, `WINDOW_SECONDS`, `MAX_SLEEP`,
     `WARMUP_THRESHOLD`.
   - Where logs go.
   - How to disable temporarily: `unset CLAUDE_THROTTLE` (or set it to
     `0`, empty, or any non-numeric value).
   - How to uninstall: `/plugin uninstall throttle@claude-throttle`.
8. `README.md` at repo root — short overview, links to plugin docs,
   install instructions for the marketplace.

## Open questions

These are decisions to make based on real-world experimentation rather
than upfront design. Resolve before v1 ships.

### Q1: Source of token-consumption data

The hook needs to know how many tokens have been used in the current
5-hour window. Options:

- **ccusage CLI** (current plan). Mature, handles window-boundary logic
  correctly. Performance: ~190ms minimum (Node.js startup), scales with
  total JSONL size — measured ~250ms for light users, ~830ms for ~6 MB
  of session data, ~2.3s for ~25 MB. Mitigations: cache result for ~10s
  in `/tmp`, use `--since` to limit scanned data. Hard dependency on
  Node.js runtime.
- **Direct JSONL parsing** with bash + jq. Read
  `~/.claude/projects/*/*.jsonl` directly, sum `usage.*` fields from
  assistant messages in the last 5 hours. Avoids Node.js startup
  entirely; expected ~50-100ms. Have to re-implement window-boundary
  logic, which is the bulk of ccusage's actual value. Risk: JSONL
  format is not a stable API (issue #41591 saw auto-updates change it).
- **tmux + `/usage` scraper on a cron.** Spawn detached `claude` session
  every N minutes, send `/usage`, capture pane buffer, parse percentages,
  write to file. Throttle hook reads the file (near-instant). Only path
  to authoritative numbers. Costs: tokens consumed by polling sessions
  (a few hundred per poll, adds up), risk of triggering new 5-hour
  windows just by monitoring, fragile TUI parsing, coarse granularity.
- **Reverse-engineered API endpoint.** `/usage` clearly hits something
  server-side. Capturable via `claude --debug` or mitmproxy. Most
  accurate, instant. Costs: depends on internal OAuth token format and
  undocumented endpoint, both can change without warning; gray-area
  TOS-wise; not a stable foundation for a public tool.
- **Wait for `claude --usage` flag.** Open feature request (#20399). If
  it ships, becomes the obviously-correct option.

Recommendation: ccusage with caching + `--since` for v1. Re-evaluate
once real-world performance numbers are in. Custom JSONL parser as a
v2 enhancement if ccusage proves too slow. Reverse-engineered endpoint
is interesting for personal use but probably not for a public tool.

### Q2: Cache layer

Whether to cache ccusage output between calls.

- **No cache.** Simplest. Every `PreToolUse` invocation re-runs
  ccusage. Adds 200ms-2s per tool call.
- **TTL cache** (e.g. `/tmp/throttle-cache.json` with 10s expiry).
  Big speedup on tool-heavy workflows. Slightly stale data, which is
  fine because pacing math doesn't need second-level precision.
- **Filesystem-mtime cache.** Re-run ccusage only when JSONL files in
  `~/.claude/projects/` have changed since last cached read. More
  accurate than TTL, slightly more code.

Recommendation: TTL cache (10s default, configurable via env var) for
v1. Measure whether mtime cache is worth the extra complexity later.



- Multi-window pacing (weekly limits). The 5-hour window is the binding
  constraint; weekly is a separate problem.
- Auto-resume after window exhaustion. That's `claude-auto-retry`'s job.
- Per-agent budgets when multiple background agents share a window. v1
  paces against the global ccusage total; per-agent allocation can come
  later if needed.