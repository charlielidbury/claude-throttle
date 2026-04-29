# statusLine `rate_limits` — implications for the throttle hook

## Discovery

Claude Code v1.2.80 (early 2026) added a `rate_limits` field to the JSON
payload that's piped to statusLine commands on every tick. The shape:

```json
{
  "model": { "display_name": "Claude Sonnet 4.6" },
  "context_window": { "used_percentage": 12.4 },
  "cost": { "total_cost_usd": 0.04 },
  "workspace": { "current_dir": "/path" },
  "rate_limits": {
    "five_hour":  { "used_percentage": 42, "resets_at": 1742651200 },
    "seven_day":  { "used_percentage": 18, "resets_at": 1743120000 }
  }
}
```

This is the **authoritative percentage** — exactly what `/usage` shows.
Anthropic computes it server-side and feeds it down through the
statusLine mechanism. No estimation, no JSONL parsing, no reverse
engineering needed.

Confirmed by:
- Anthropic docs: <https://code.claude.com/docs/en/statusline>
- Real-world post documenting the field shape:
  <https://www.dandoescode.com/blog/claude-code-custom-statusline>
- Several community statusbar projects already consume it
  (e.g. `daniel3303/ClaudeCodeStatusLine`, `leeguooooo/claude-code-usage-bar`).

## What this changes

The current throttle plan uses ccusage to estimate window consumption.
ccusage reads `~/.claude/projects/*.jsonl` files and reconstructs the
5-hour billing block. It's an approximation — accurate enough but not
ground truth — and adds 200ms-2s of Node.js startup overhead per call.

statusLine `rate_limits.five_hour.used_percentage` is:

- **Authoritative.** Same number as `/usage`, computed by Anthropic.
- **Cheap.** Already being computed for the statusbar; we'd just
  intercept it.
- **No external deps.** No ccusage, no Node.js, no JSONL parsing.

## Where it doesn't help directly

`PreToolUse` hooks **do not** receive `rate_limits` in their stdin JSON.
This is a separate channel — statusLine gets it, hooks don't.

Confirmed in issue #36056 (March 2026):
> "Hooks don't receive rate limit data — Notification, Stop, PreToolUse,
> PostToolUse hooks receive context about the event but not the current
> rate limit state."

So the throttle hook can't read it directly from its own stdin.

## The architecture this unlocks

A two-component plugin where statusLine is the data producer and the
hook is the data consumer:

```
┌─────────────────┐       writes      ┌──────────────────┐
│  statusLine     │ ───────────────▶  │ /tmp/claude-     │
│  (every tick)   │                   │ rate-limits.json │
│                 │                   └──────────────────┘
│  reads          │                            │
│  rate_limits    │                            │ reads
│  from stdin     │                            ▼
└─────────────────┘                   ┌──────────────────┐
                                      │  PreToolUse      │
                                      │  throttle hook   │
                                      │                  │
                                      │  decides:        │
                                      │  sleep or skip   │
                                      └──────────────────┘
```

### Component 1: statusLine cache writer

A bash one-liner registered in `statusLine.command`. On each tick:

1. Reads JSON from stdin.
2. Extracts `rate_limits` plus a `now` timestamp.
3. Writes to `/tmp/claude-rate-limits.json` atomically (write to temp,
   rename).
4. Outputs whatever it wants for the visible status bar (or nothing).

Roughly:

```bash
jq -c '{
  five_hour: .rate_limits.five_hour,
  seven_day: .rate_limits.seven_day,
  cached_at: now
}' > /tmp/claude-rate-limits.json.tmp
mv /tmp/claude-rate-limits.json.tmp /tmp/claude-rate-limits.json
```

### Component 2: PreToolUse throttle hook

Reads the cache file, applies the same pacing math from the original
plan, decides whether to sleep. Pseudocode:

```bash
cache=/tmp/claude-rate-limits.json
[ ! -f "$cache" ] && exit 0  # no data yet, can't pace
five_hour_pct=$(jq -r '.five_hour.used_percentage' "$cache")
elapsed_pct=$(compute_elapsed_pct "$cache")
# pace_ratio = five_hour_pct / (CLAUDE_THROTTLE * elapsed_pct)
# if > 1, sleep
```

Hot path: one `cat`, one `jq`, some arithmetic. Sub-50ms total.

## What changes in the original plan

Trimming:

- **ccusage dependency goes away.** No `npm install -g ccusage`.
- **Node.js dependency goes away.** Pure bash + jq.
- **Cache layer (Q2 in the open questions) goes away.** statusLine
  *is* the cache.
- **Performance section goes away.** The hook is cheap by construction.
- **The whole "data source" open question (Q1) becomes resolved** —
  statusLine is clearly the right answer when available.
- **Warmup bypass justification simplifies.** No more division-by-zero
  worry from ccusage's `tokens / elapsed`. The data is just a percentage
  Anthropic computed; no math at the source.

Adding:

- **A statusLine command** ships as part of the plugin. Plugins can
  declare a `statusLine` in their settings, so this can be automatic on
  install.
- **A cache-file freshness check.** statusLine ticks during active
  Claude Code sessions but not when idle. If the cache is older than N
  seconds (say, 60s), the hook should treat it as missing and skip
  pacing — the data is too stale to act on.
- **Coordination with user's existing statusLine.** If the user already
  has a statusLine configured (e.g. ccstatusline), our plugin can't
  just overwrite it. Two options: (a) document a manual merge; (b) ship
  the throttle's statusLine as a wrapper that calls the user's existing
  one and writes the cache file as a side effect.

## Rate-limit math changes

The original plan computes pace ratio as:

```
pace_ratio = (tokens_consumed / token_budget) / (elapsed / 18000)
```

where `tokens_consumed` and `token_budget` are absolute numbers from
ccusage.

With the statusLine data, we have `used_percentage` directly. The
budget multiplier `CLAUDE_THROTTLE` still applies, but the formula
simplifies:

```
elapsed_pct = (now - window_start) / 18000
pace_ratio  = (used_percentage / 100) / (CLAUDE_THROTTLE * elapsed_pct)
```

`window_start` can be derived from `resets_at - 18000`. This is more
correct than ccusage's window detection because Anthropic is the one
defining when the window started.

`TOKEN_BUDGET` becomes redundant — we're already pacing against
percentage-of-quota directly, so the user only needs to set
`CLAUDE_THROTTLE` (the headroom multiplier).

## Caveats

- **Version requirement.** Needs Claude Code v1.2.80 or later.
  Released early 2026; almost certainly already on every active user's
  machine, but worth a runtime check.

- **Field availability is not guaranteed forever.** Anthropic could
  rename or remove `rate_limits` in a future version. If the field is
  missing, the statusLine writer should write a sentinel value and the
  hook should detect it and fall back to a no-op (or to ccusage as a
  v2 fallback path).

- **statusLine tick cadence.** Documented as running on each Claude
  Code update; in practice this is frequent during active work and
  paused when idle. The freshness check handles idle gaps.

- **Multiple Claude Code instances.** If the user runs two `claude`
  sessions concurrently, both statusLines write to the same cache
  file. That's fine — the data is the same global percentage either
  way. Last-write-wins is the correct semantics here.

- **Weekly limits available too.** `seven_day` is in the same payload.
  The throttle hook could optionally pace against the weekly window in
  addition to the 5-hour window. Worth considering as a v2 feature.

## Recommendation

Pivot the v1 design to use statusLine as the data source. The plan's
core (pacing math, env-var multiplier, warmup bypass, plugin
distribution, sleep cap, user notification via `systemMessage`) all
stay the same. The only thing that changes is where token-consumption
data comes from and the resulting simplifications.

Keep ccusage as a documented v2 fallback for users on older Claude Code
versions that don't expose `rate_limits` yet.