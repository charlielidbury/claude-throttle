// Pure auto-balance decision logic, isolated for unit testing.
// No I/O, no clock access except via injected `now`.

export const HYSTERESIS_PCT = 5; // candidate must be >= this many points below active
export const MIN_DWELL_MS = 3 * 60 * 1000; // min time between auto-switches
export const ACTIVE_POLL_MS = 60 * 1000; // re-fetch active usage this often
export const INACTIVE_POLL_MS = 5 * 60 * 1000; // re-fetch/refresh inactive at most this often
export const USAGE_REFRESH_MS = 30_000; // all-accounts usage refresh cadence (the `u` toggle)
// Treat tokens expiring within this window as needing a refresh before a usage fetch.
export const NEAR_EXPIRY_MS = 60_000;

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
};

export type PassCallbacks<U> = {
  /** Refresh the token for an account (only called for expired/near-expiry, non-active). */
  refreshIfExpired: (name: string) => Promise<{ expiresAt: number } | null>;
  /** Fetch usage for an account; returns the new usage value. */
  fetchUsage: (name: string) => Promise<U>;
};

export type PassResult<U> = {
  name: string;
  usage: U;
  refreshed: boolean; // whether a token refresh was performed this pass
  fetched: boolean; // whether a usage fetch was performed this pass
};

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
 * For each DUE account: refresh the token only if expired/near-expiry (and not
 * active), then fetch usage. Returns per-account results. Pure orchestration —
 * all I/O goes through the injected callbacks, so it is fully testable.
 */
export async function runUsagePass<U>(
  accounts: PassAccount<U>[],
  now: number,
  forceAll: boolean,
  cb: PassCallbacks<U>,
): Promise<PassResult<U>[]> {
  return Promise.all(
    accounts.map(async (a): Promise<PassResult<U>> => {
      if (!isDue(a, now, forceAll)) {
        return { name: a.name, usage: a.usage, refreshed: false, fetched: false };
      }
      let refreshed = false;
      let expiresAt = a.expiresAt;
      if (needsRefresh(a, now)) {
        try {
          const r = await cb.refreshIfExpired(a.name);
          if (r) {
            refreshed = true;
            expiresAt = r.expiresAt;
          }
        } catch {
          // leave token as-is; the usage fetch will likely fail -> unchanged usage
        }
      }
      // If still expired after a failed/absent refresh, skip the doomed fetch.
      if (!a.isActive && expiresAt && expiresAt <= now) {
        return { name: a.name, usage: a.usage, refreshed, fetched: false };
      }
      try {
        const usage = await cb.fetchUsage(a.name);
        return { name: a.name, usage, refreshed, fetched: true };
      } catch {
        return { name: a.name, usage: a.usage, refreshed, fetched: false };
      }
    }),
  );
}
