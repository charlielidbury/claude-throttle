// Pure auto-balance decision logic, isolated for unit testing.
// No I/O, no clock access except via injected `now`.

export const HYSTERESIS_PCT = 5; // candidate must be >= this many points below active
export const MIN_DWELL_MS = 3 * 60 * 1000; // min time between auto-switches
export const ACTIVE_POLL_MS = 60 * 1000; // re-fetch active usage this often
export const INACTIVE_POLL_MS = 5 * 60 * 1000; // re-fetch/refresh inactive at most this often
export const USAGE_REFRESH_MS = 30_000; // all-accounts usage refresh cadence (the `u` toggle)
// Treat tokens expiring within this window as needing a refresh before a usage fetch.
export const NEAR_EXPIRY_MS = 60_000;
// Small gap between sequential requests in a pass, to avoid bursting the API.
export const PASS_REQUEST_GAP_MS = 250;
// Exponential backoff for a repeatedly-failing token refresh (dead refresh
// token etc.): wait base * 2^(failures-1), capped. Prevents hammering /token
// every tick (which both wastes calls and contributes to rate-limit bursts).
export const REFRESH_BACKOFF_BASE_MS = 60_000; // 1 min after the first failure
export const REFRESH_BACKOFF_MAX_MS = 30 * 60_000; // capped at 30 min

export type BalanceAccount = {
  name: string;
  inRotation: boolean;
  /** max(5h%, 7d%) as a percentage, or null if usage is unknown/unmeasurable. */
  score: number | null;
};

export type BalanceInput = {
  accounts: BalanceAccount[];
  active: string | null;
  lastAutoSwitchAt: number | null; // epoch ms of the previous auto-switch, or null
  now: number; // epoch ms
};

export type BalanceDecision = {
  target: string | null; // slot to switch to, or null for no-op
  reason: string; // human-readable explanation (always set)
  activeScore: number | null;
  candidateScore: number | null;
};

/**
 * Decide whether the auto-balancer should switch the active account.
 *
 * Rules:
 *  - Candidate pool = in-rotation accounts with a KNOWN (non-null) score.
 *  - Candidate = the lowest-scoring account in that pool (ties broken by name
 *    for determinism).
 *  - Switch to candidate ONLY IF:
 *      (a) candidate !== active, AND
 *      (b) active's score is known, AND
 *      (c) activeScore - candidateScore >= HYSTERESIS_PCT, AND
 *      (d) at least MIN_DWELL_MS since the last auto-switch.
 *  - Never targets an out-of-rotation or unknown-score account.
 *  - No-op if active is already the best (or within hysteresis of it).
 */
export function decideAutoSwitch(input: BalanceInput): BalanceDecision {
  const { accounts, active, lastAutoSwitchAt, now } = input;

  const activeAcct = active ? accounts.find((a) => a.name === active) ?? null : null;
  const activeScore = activeAcct ? activeAcct.score : null;

  // Eligible switch-TO candidates: in rotation, known score.
  const eligible = accounts
    .filter((a) => a.inRotation && a.score !== null)
    .sort((a, b) => {
      if (a.score! !== b.score!) return a.score! - b.score!;
      return a.name.localeCompare(b.name);
    });

  const best = eligible[0] ?? null;
  const candidateScore = best ? best.score : null;

  if (!best) {
    return { target: null, reason: "no eligible candidate", activeScore, candidateScore: null };
  }
  if (best.name === active) {
    return {
      target: null,
      reason: "active is already the lowest-used",
      activeScore,
      candidateScore,
    };
  }
  if (activeScore === null) {
    // We can't measure how loaded the current active is, so we can't justify a
    // switch on the "least-used" rule. (Active may still be unknown/unmeasured.)
    return {
      target: null,
      reason: "active usage unknown — cannot compare",
      activeScore,
      candidateScore,
    };
  }
  const gap = activeScore - candidateScore!;
  if (gap < HYSTERESIS_PCT) {
    return {
      target: null,
      reason: `gap ${gap}% < hysteresis ${HYSTERESIS_PCT}%`,
      activeScore,
      candidateScore,
    };
  }
  if (lastAutoSwitchAt !== null && now - lastAutoSwitchAt < MIN_DWELL_MS) {
    const waitS = Math.ceil((MIN_DWELL_MS - (now - lastAutoSwitchAt)) / 1000);
    return {
      target: null,
      reason: `min-dwell: ${waitS}s remaining`,
      activeScore,
      candidateScore,
    };
  }
  return {
    target: best.name,
    reason: `switch ${active}(${activeScore}%) → ${best.name}(${candidateScore}%)`,
    activeScore,
    candidateScore,
  };
}

/**
 * Seconds remaining until the next scheduled usage-refresh pass, for display.
 * Rounds up (so a fresh window shows the full cadence) and clamps at 0.
 * `nextRefreshAt` null/undefined => 0.
 */
export function remainingSeconds(nextRefreshAt: number | null | undefined, now: number): number {
  if (!nextRefreshAt) return 0;
  return Math.max(0, Math.ceil((nextRefreshAt - now) / 1000));
}

/** Score from a usage object: max(5h%, 7d%). null if usage unknown. */
export function usageScore(
  usage: { fiveHour: { use: number }; sevenDay: { use: number } } | "loading" | "error" | null,
): number | null {
  if (!usage || usage === "loading" || usage === "error") return null;
  return Math.max(usage.fiveHour.use, usage.sevenDay.use);
}

// ---------------------------------------------------------------------------
// Usage-refresh pass — the unified per-tick work, isolated for testing.
// ---------------------------------------------------------------------------
export type PassAccount<U> = {
  name: string;
  isActive: boolean;
  inRotation: boolean;
  expiresAt: number; // epoch ms; 0/absent => treat as unknown/expired
  lastUsageAt: number | null;
  usage: U; // current usage value (left unchanged on fetch failure)
  // Refresh-failure tracking, for exponential backoff of a dead refresh token.
  refreshFailures?: number;
  lastRefreshFailAt?: number | null;
};

export type PassCallbacks<U> = {
  /** Refresh the token for an account (only called for expired/near-expiry, non-active). */
  refreshIfExpired: (name: string) => Promise<{ expiresAt: number } | null>;
  /** Fetch usage for an account; returns the new usage value. */
  fetchUsage: (name: string) => Promise<U>;
  /**
   * True if a usage value represents a transient failure (e.g. the "error"
   * sentinel from an HTTP error / 429). Such values MUST NOT clobber a prior
   * good value, so the pass reports them as fetched:false.
   */
  isError: (usage: U) => boolean;
  /** Optional sleep between sequential requests (defaults to a real timer). */
  sleep?: (ms: number) => Promise<void>;
  /** Gap between requests; defaults to PASS_REQUEST_GAP_MS. */
  gapMs?: number;
};

export type PassResult<U> = {
  name: string;
  usage: U;
  refreshed: boolean; // whether a token refresh was performed this pass
  fetched: boolean; // whether a usage fetch SUCCEEDED this pass (false on error)
  refreshFailed: boolean; // whether a refresh attempt failed this pass
  refreshSkippedBackoff: boolean; // whether refresh was skipped due to backoff
};

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long to wait before retrying a refresh, given consecutive failures.
 * 0 failures => 0 (no wait). Exponential from REFRESH_BACKOFF_BASE_MS, capped.
 */
export function refreshBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  const ms = REFRESH_BACKOFF_BASE_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(ms, REFRESH_BACKOFF_MAX_MS);
}

/**
 * Whether a refresh is currently backed off given the last failure time and
 * the consecutive-failure count.
 */
export function isRefreshBackedOff(
  lastRefreshFailAt: number | null | undefined,
  consecutiveFailures: number | undefined,
  now: number,
): boolean {
  const fails = consecutiveFailures ?? 0;
  if (fails <= 0 || !lastRefreshFailAt) return false;
  return now - lastRefreshFailAt < refreshBackoffMs(fails);
}

/**
 * Decide whether an account is due for a usage fetch this tick.
 * - forceAll (the `u` toggle ON): every account, every tick.
 * - otherwise (auto-balance only): active ~every ACTIVE_POLL_MS; in-rotation
 *   inactive ~every INACTIVE_POLL_MS; out-of-rotation inactive: skip.
 */
export function isDue<U>(a: PassAccount<U>, now: number, forceAll: boolean): boolean {
  if (forceAll) return true;
  const last = a.lastUsageAt ?? 0;
  if (a.isActive) return now - last >= ACTIVE_POLL_MS;
  if (!a.inRotation) return false;
  return now - last >= INACTIVE_POLL_MS;
}

/** Whether this account needs a token refresh before a usage fetch. */
export function needsRefresh<U>(a: PassAccount<U>, now: number): boolean {
  // The active account is kept live by Claude Code itself — never refresh it here.
  if (a.isActive) return false;
  if (!a.expiresAt) return true; // unknown expiry -> treat as needing refresh
  return a.expiresAt - now <= NEAR_EXPIRY_MS;
}

/**
 * Run one usage-refresh pass over the given accounts.
 *
 * Requests are issued SEQUENTIALLY (concurrency 1) with a small gap between
 * them — never a Promise.all burst — because a refresh POST firing alongside
 * other accounts' usage GETs trips Anthropic's rate limit (HTTP 429), which
 * then poisons the GETs. A refresh is only attempted for expired/near-expiry,
 * non-active accounts, and is skipped while backed off after repeated failures.
 *
 * A usage result the caller flags as an error (cb.isError) is reported as
 * fetched:false so the apply step keeps the prior good value instead of
 * clobbering it with "—".
 *
 * Pure orchestration — all I/O goes through the injected callbacks, so it is
 * fully testable.
 */
export async function runUsagePass<U>(
  accounts: PassAccount<U>[],
  now: number,
  forceAll: boolean,
  cb: PassCallbacks<U>,
): Promise<PassResult<U>[]> {
  const sleep = cb.sleep ?? realSleep;
  const gapMs = cb.gapMs ?? PASS_REQUEST_GAP_MS;
  const results: PassResult<U>[] = [];
  let issued = 0; // count of actual network requests, to pace the gap

  for (const a of accounts) {
    const base: PassResult<U> = {
      name: a.name,
      usage: a.usage,
      refreshed: false,
      fetched: false,
      refreshFailed: false,
      refreshSkippedBackoff: false,
    };

    if (!isDue(a, now, forceAll)) {
      results.push(base);
      continue;
    }

    let expiresAt = a.expiresAt;

    // --- refresh (only if needed and not backed off) ---
    if (needsRefresh(a, now)) {
      if (isRefreshBackedOff(a.lastRefreshFailAt, a.refreshFailures, now)) {
        base.refreshSkippedBackoff = true;
      } else {
        if (issued > 0) await sleep(gapMs);
        issued++;
        try {
          const r = await cb.refreshIfExpired(a.name);
          if (r) {
            base.refreshed = true;
            expiresAt = r.expiresAt;
          } else {
            base.refreshFailed = true; // callback signalled failure (null)
          }
        } catch {
          base.refreshFailed = true;
        }
      }
    }

    // If still expired (refresh failed/absent), skip the doomed usage GET.
    if (!a.isActive && expiresAt && expiresAt <= now) {
      results.push(base);
      continue;
    }

    // --- usage GET ---
    if (issued > 0) await sleep(gapMs);
    issued++;
    try {
      const usage = await cb.fetchUsage(a.name);
      if (cb.isError(usage)) {
        // Transient failure (e.g. 429) — do NOT overwrite the prior value.
        results.push(base);
      } else {
        results.push({ ...base, usage, fetched: true });
      }
    } catch {
      results.push(base); // keep prior value
    }
  }

  return results;
}
