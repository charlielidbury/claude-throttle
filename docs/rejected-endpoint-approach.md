# Rejected approach: reading `/api/oauth/usage` directly

This is a record of an approach we considered and rejected in favour of
the statusLine cache-file mechanism. Keeping the notes around because
the endpoint is a useful debug tool (`usage.sh`) and may become the
right answer again if statusLine ever stops carrying `rate_limits`.

## What it is

Claude Code's `/usage` slash command queries an internal endpoint that
returns server-authoritative rate-limit utilization. The throttle could
hit the same endpoint directly:

```
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <oauth_access_token>
anthropic-beta: oauth-2025-04-20
```

The OAuth access token lives at `~/.claude/.credentials.json` under
`.claudeAiOauth.accessToken`. Live response shape:

```json
{
  "five_hour": {"utilization": 55.0, "resets_at": "2026-04-29T13:20:00+00:00"},
  "seven_day": {"utilization": 79.0, "resets_at": "2026-04-29T17:00:00+00:00"},
  "seven_day_opus":   {"utilization": 0.0, "resets_at": null},
  "seven_day_sonnet": {"utilization": 0.0, "resets_at": null},
  "extra_usage":      {"is_enabled": false, ...}
}
```

`utilization` is 0–100 percent. Same number Claude Code itself shows in
`/usage`, and the same number that ends up in statusLine's
`rate_limits.*.used_percentage` (Claude Code's StatusLine.tsx multiplies
the underlying fraction by 100 before piping it).

`usage.sh` at the repo root prints this JSON for ad-hoc inspection. We
kept it around because it's a useful debug tool independent of the
throttle.

## Why we rejected it

1. **Undocumented.** The endpoint is internal — no public reference, no
   stability commitment. statusLine `rate_limits` is in the official
   Claude Code statusLine docs and consumed by several community
   projects, so it has a much stronger stability signal.

2. **Extra moving parts.** The throttle would have to read OAuth tokens
   from `.credentials.json`, handle 401s on token expiry, manage
   network errors, and decide on a sensible cache TTL — all to compute
   a number that statusLine already pipes to us for free.

3. **Slower per call.** Each cache-miss costs a ~200ms HTTP round-trip.
   statusLine cache reads are essentially free.

The only real argument for the endpoint is that it works in
non-interactive (`claude -p`) mode where statusLine doesn't fire. We
don't run agents in non-interactive mode, so this isn't relevant for
us.

## When this might come back

- Anthropic removes or renames `rate_limits` in the statusLine payload.
  Unlikely without a migration path, but the throttle should handle a
  missing field gracefully (already does — falls back to no-op pacing).
- We start running background agents in `claude -p` mode. Then we'd
  need a non-statusLine source.
- The cache-staleness issue (statusLine ticks on assistant-message
  events, not on a timer) turns out to bite hard in practice. The
  endpoint is always fresh; statusLine can lag during tool-heavy turns.

If any of these happen, this approach is the obvious fallback. The full
recipe is preserved in this doc and `usage.sh` keeps working.
