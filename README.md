# Claude Throttle

Slows Claude down such that it stays within your 5h session limits.

<img width="419" height="312" alt="image" src="https://github.com/user-attachments/assets/fc68faa8-b518-4470-90b6-4f617112ba0d" />

So if you are x% the way through your 5h session limit, this will slow Claude down (by insertting a `sleep` call on every tool use) iff it has used more than x% of your tokens.

Because this uses the global usage statistics, throttled claude sessions will slow down in response to _any_ usage on your account.

For example:
- You have a background Ralph Loop (Agent A, throttle=ENABLED) running which is using on average 90% of every 5h window
- Because this is within your limits, it doesn't get throttled at all
- Now, you start using Claude interactively (Agent B, throttle=DISABLED) _in parallel_ with this background agent
- Your interactive usage with Agent B causes global usage to spike
- This causes Agent A (the throttled background agent) to slow down until global usage is below the "token usage% = time usage%" line.

TL;DR: You can fire off background agents and leave them running for days without worrying about them using up your limits and interupting your interactive usage, or other background agents.

## Install

```sh
git clone https://github.com/charlielidbury/claude-throttle.git ~/claude-throttle
~/claude-throttle/install.sh
```

Adds a `statusLine` and a `PreToolUse` hook to `~/.claude/settings.json`.
Backs up the existing file before writing. Refuses to clobber an existing
`statusLine` without `--force`.

## Use

`install.sh` installs the throttle hooks on every claude session, but they lay dormant until they detect `CLAUDE_THROTTLE` env var has been set.

`CLAUDE_THROTTLE` determines the _gradient_ of the line the throttler will keep usage below. `CLAUDE_THROTTLE=1` means "use all of limits", `CLAUDE_THROTTLE=0.5` means "throttle until global usage below 50%"

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

Top Tip: If you want Agent A to have _priority_ over Agent B in terms of usage, give agent A a higher multipler. For example if CLAUDE_THROTTLE=0.9 in Agent A and 0.8 in Agent B then under a high contention scenario Agent B will get throttled _first_, causing Agent A to only be slowed done once the throttler has already tried slowing down B.

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
