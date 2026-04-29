# claude-throttle

Pace Claude Code's rate-limit utilization against elapsed time within the
5-hour and 7-day billing windows, so background agents don't burn through
the limit before the window resets.

## Install

```sh
git clone https://github.com/charlielidbury/claude-throttle.git ~/claude-throttle
~/claude-throttle/install.sh
```

Adds a `statusLine` and a `PreToolUse` hook to `~/.claude/settings.json`.
Backs up the existing file before writing. Refuses to clobber an existing
`statusLine` without `--force`.

## Use

```sh
export CLAUDE_THROTTLE=0.9   # multiplier in (0, 1]
claude
```

Lower values are more conservative (`0.5` = use up to half the window
budget evenly). `unset CLAUDE_THROTTLE` (or set to `0` / empty) disables
throttling for that session — the hook becomes a no-op.

Throttling only engages in interactive sessions. `claude -p` (headless)
doesn't fire `statusLine`, so there's no live data and the hook stays
silent.

## Status bar

```
thr:0.7 | 5h:(56%/80%) 7d:(79%/92%) | session:32m (n=5)
```

- `thr:N` — current multiplier (or `off`)
- `5h:(usage%/window%)` — current utilization paired with elapsed
  fraction of the 5-hour window
- `7d:` same for the 7-day window
- `session:DUR (n=N)` — total sleep time + throttle event count for the
  current session (omitted until the first sleep)

## Pacing

For each window, sleep before a tool call iff the agent is ahead of the
linear-pacing target:

```
used_percentage / 100  >  CLAUDE_THROTTLE × elapsed_fraction
```

The hook reads server-authoritative utilization from a cache file
written by `statusline.sh` — Claude Code pipes the same `rate_limits`
field that powers `/usage`. A single sleep is capped at 540s; longer
catchup spans multiple tool calls.

If the cache is stale (>30min) or has no `rate_limits` (cold start, no
API response yet), the hook is a no-op.

## Tuning

| Env var | Default | Effect |
|---|---|---|
| `CLAUDE_THROTTLE` | unset | Multiplier (0, 1]. Required to engage. |
| `MAX_SLEEP` | 540 | Per-call sleep cap, seconds. |
| `WARMUP_THRESHOLD_PCT` | 10 | Skip pacing while a window's util < this %. |
| `MAX_CACHE_AGE_S` | 1800 | Treat older cache as missing. |
| `THROTTLE_LOG` | `~/.claude/throttle.log` | Log path. |
| `CLAUDE_THROTTLE_CACHE` | `/tmp/claude-throttle-cache.json` | Cache path. |
| `CLAUDE_THROTTLE_STATS_DIR` | `/tmp` | Per-session stats files live here. |

## Files

- `scripts/statusline.sh` — writes cache + prints status bar text
- `scripts/throttle.sh` — `PreToolUse` hook (reads cache, sleeps)
- `install.sh` / `uninstall.sh` — manage `~/.claude/settings.json`
- `usage.sh` — debug helper; prints raw `/api/oauth/usage` response
- `docs/` — design notes, including the rejected endpoint approach

## Tests

```sh
bash tests/test-throttle.sh     # 24 unit tests for the hook
bash tests/test-statusline.sh   # 21 unit tests for the status writer
```

## Uninstall

```sh
~/claude-throttle/uninstall.sh
```

Removes only entries that point at this repo's scripts. Backs up before
writing.
