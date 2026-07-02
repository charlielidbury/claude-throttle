// Ink-free core: path/env resolution, constants, types, slot loading, and
// read-only usage/profile fetches. Shared by the TUI (src/index.tsx) and the
// CLI (src/cli.ts). Everything here is parameterized on a `Paths` object from
// credstore.ts and reuses credstore's state read/write so there is a single
// source of truth for the state file schema.
import { homedir } from "node:os";
import { join } from "node:path";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  makePaths,
  readState,
  writeState,
  emptyCache,
  type Paths,
  type AccountCache,
  type SwitcherState,
} from "./credstore";

export type { Paths, AccountCache, SwitcherState };

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
// claudeDir honors an env override so the app can be pointed at a throwaway
// copy for testing (NEVER mutate the real ~/.claude during verification).
// Precedence: SWITCHER_CLAUDE_DIR > CLAUDE_CONFIG_DIR > ~/.claude.
export function claudeDir(): string {
  return (
    process.env.SWITCHER_CLAUDE_DIR ||
    process.env.CLAUDE_CONFIG_DIR ||
    join(homedir(), ".claude")
  );
}

export function paths(): Paths {
  return makePaths(claudeDir());
}

export const SLOT_RE = /^\.(.+)\.credentials\.json$/;
export const CRED_MODE = 0o600;

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

export const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const USAGE_HEADERS = {
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
};
export const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type OAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

export type CredFile = { claudeAiOauth: OAuth };

export type Window = { use: number; elapsed: number };
export type Usage = { fiveHour: Window; sevenDay: Window } | "loading" | "error";

export type Slot = {
  name: string;
  path: string;
  oauth: OAuth;
  usage: Usage;
  cache: AccountCache;
};

export type Profile = {
  email: string | null;
  displayName: string | null;
  uuid: string | null;
};

// ---------------------------------------------------------------------------
// Slot discovery
// ---------------------------------------------------------------------------
export function readOAuth(path: string): OAuth {
  const data = JSON.parse(readFileSync(path, "utf8")) as CredFile;
  return data.claudeAiOauth;
}

export function discoverSlots(p: Paths): Slot[] {
  const entries = readdirSync(p.dir);
  const slots: Slot[] = [];
  for (const entry of entries) {
    if (entry === ".credentials.json") continue;
    const m = entry.match(SLOT_RE);
    if (!m) continue;
    const name = m[1];
    const path = join(p.dir, entry);
    try {
      slots.push({
        name,
        path,
        oauth: readOAuth(path),
        usage: "loading",
        cache: emptyCache(),
      });
    } catch {
      // skip unparseable slot files
    }
  }
  slots.sort((a, b) => a.name.localeCompare(b.name));
  return slots;
}

// ---------------------------------------------------------------------------
// Identity fingerprinting + cache self-correction
// ---------------------------------------------------------------------------
// The email/displayName/uuid cache in the state file is keyed by SLOT NAME. If
// a slot's underlying account changes (e.g. a re-login drops a different
// account's token into `.brit.credentials.json`), the cached identity goes
// stale and would mislabel the row. We guard against that two ways:
//   1. On load (cheap, no network): fingerprint the slot's current refresh
//      token and compare to the fingerprint stored when the identity was
//      resolved. Mismatch => clear the cached identity so it re-resolves.
//   2. On profile fetch (authoritative): if the freshly fetched uuid differs
//      from the cached uuid, overwrite the identity (don't keep the old email).
// A normal in-place token refresh (same account, rotated token) updates the
// fingerprint alongside the cache, so rotation does NOT invalidate.

/** Stable fingerprint of a slot's credential identity (hash of refresh token). */
export function identityFingerprint(oauth: OAuth): string {
  const token = oauth.refreshToken ?? "";
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * Reconcile a cached AccountCache against the slot's CURRENT oauth, by
 * fingerprint. Pure; returns the (possibly cleared) cache.
 * - No cached identity (no email & no uuid) => stamp the current fingerprint
 *   (nothing to invalidate, but record identity for next time).
 * - Fingerprint matches (or none stored yet but identity present) => keep, and
 *   backfill the fingerprint if it was absent (legacy entries).
 * - Fingerprint present and DIFFERENT => the slot now holds a different
 *   account's token: clear email/displayName/uuid and restamp the fingerprint.
 */
export function reconcileCachedIdentity(
  cache: AccountCache,
  oauth: OAuth,
): AccountCache {
  const fp = identityFingerprint(oauth);
  const hasIdentity = Boolean(cache.email || cache.uuid);
  if (!cache.identityFingerprint) {
    // Legacy / freshly-created entry: record the current fingerprint. Keep any
    // existing identity (we have no prior fingerprint to contradict it).
    return { ...cache, identityFingerprint: fp };
  }
  if (cache.identityFingerprint === fp) {
    return cache; // same account/token -> trust the cache
  }
  // Fingerprint changed.
  if (!hasIdentity) {
    return { ...cache, identityFingerprint: fp };
  }
  // Stale identity for a now-different account: clear it so it re-resolves.
  return {
    ...cache,
    email: null,
    displayName: null,
    uuid: null,
    identityFingerprint: fp,
  };
}

/**
 * Merge a freshly fetched profile into a cache entry, self-correcting on a uuid
 * change. If the fetched uuid differs from the cached one, the cached identity
 * belonged to a DIFFERENT account — overwrite email/displayName/uuid wholesale
 * (do not keep the old email). Always restamp the fingerprint to the current
 * token so a subsequent load trusts the cache.
 */
export function mergeProfileIntoCache(
  cache: AccountCache,
  profile: { email?: string | null; displayName?: string | null; uuid?: string | null },
  oauth: OAuth,
): AccountCache {
  const fp = identityFingerprint(oauth);
  const uuidChanged =
    profile.uuid != null && cache.uuid != null && profile.uuid !== cache.uuid;
  if (uuidChanged) {
    // Different account in this slot: replace the identity entirely.
    return {
      ...cache,
      email: profile.email ?? null,
      displayName: profile.displayName ?? null,
      uuid: profile.uuid ?? null,
      identityFingerprint: fp,
    };
  }
  // Same (or previously-unknown) account: fill in without clobbering with nulls.
  return {
    ...cache,
    email: profile.email ?? cache.email,
    displayName: profile.displayName ?? cache.displayName,
    uuid: profile.uuid ?? cache.uuid ?? null,
    identityFingerprint: fp,
  };
}

// ---------------------------------------------------------------------------
// State reconciliation (active resolution + self-heal)
// ---------------------------------------------------------------------------
function bytesEqual(a: string, b: string): boolean {
  try {
    const ba = readFileSync(a);
    const bb = readFileSync(b);
    return ba.length === bb.length && ba.equals(bb);
  } catch {
    return false;
  }
}

/**
 * Resolve active slot + reconcile the state file against the slots on disk.
 * - active: from state.active if it still exists; else byte-compare and self-heal.
 * - accounts: prune missing slots, add entries for new slots (preserving caches).
 * Returns the (possibly updated) state, which is written back if it changed.
 */
export function loadState(p: Paths, slots: Slot[]): SwitcherState {
  const state = readState(p);
  const names = new Set(slots.map((s) => s.name));

  // Reconcile accounts: keep existing caches, add new, drop gone. Also
  // self-correct a stale identity if the slot's token now belongs to a
  // different account (fingerprint mismatch).
  const accounts: Record<string, AccountCache> = {};
  for (const s of slots) {
    const cache = state.accounts[s.name] ?? emptyCache();
    accounts[s.name] = reconcileCachedIdentity(cache, s.oauth);
  }

  // Resolve active.
  let active: string | null = null;
  if (state.active && names.has(state.active)) {
    active = state.active;
  } else if (existsSync(p.active)) {
    for (const s of slots) {
      if (bytesEqual(p.active, s.path)) {
        active = s.name; // self-heal below
        break;
      }
    }
  }

  const next: SwitcherState = {
    active,
    accounts,
    lastAutoSwitchAt: state.lastAutoSwitchAt ?? null,
  };
  // Persist if anything changed (self-heal active, prune/add accounts).
  if (
    next.active !== state.active ||
    JSON.stringify(next.accounts) !== JSON.stringify(state.accounts)
  ) {
    try {
      writeState(p, next);
    } catch {
      // non-fatal: callers still work from in-memory state
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Slot hydration: attach cached profile from the state file to each slot.
// ---------------------------------------------------------------------------
export function hydrateSlots(slots: Slot[], state: SwitcherState): Slot[] {
  return slots.map((s) => ({ ...s, cache: state.accounts[s.name] ?? emptyCache() }));
}

export function loadAll(p: Paths): { slots: Slot[]; active: string | null } {
  const raw = discoverSlots(p);
  const state = loadState(p, raw);
  return { slots: hydrateSlots(raw, state), active: state.active };
}

// ---------------------------------------------------------------------------
// Usage fetch (read-only GET — never refreshes a token)
// ---------------------------------------------------------------------------
function elapsedPct(resetsAtIso: string, windowMs: number, now: number): number {
  const resetsAt = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsAt)) return 0;
  const elapsed = 1 - (resetsAt - now) / windowMs;
  return Math.max(0, Math.min(100, Math.round(elapsed * 100)));
}

// When the API rate-limits us (429), don't keep hammering: hold off all usage
// GETs until this timestamp (honoring Retry-After when the server sends it).
let usageBackoffUntil = 0;

function parseRetryAfterMs(res: Response): number {
  const h = res.headers.get("retry-after");
  if (h) {
    const secs = Number(h);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const date = Date.parse(h);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return 5000; // sane default backoff if no header
}

export async function fetchUsage(oauth: OAuth): Promise<Usage> {
  // Skip a guaranteed-failing call for already-expired tokens.
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return "error";
  // Respect an active rate-limit backoff window.
  if (Date.now() < usageBackoffUntil) return "error";
  try {
    const res = await fetch(USAGE_URL, {
      headers: { ...USAGE_HEADERS, Authorization: `Bearer ${oauth.accessToken}` },
    });
    if (res.status === 429) {
      usageBackoffUntil = Date.now() + parseRetryAfterMs(res);
      return "error";
    }
    if (!res.ok) return "error";
    const body = (await res.json()) as {
      five_hour?: { utilization: number; resets_at: string };
      seven_day?: { utilization: number; resets_at: string };
    };
    if (!body.five_hour || !body.seven_day) return "error";
    const now = Date.now();
    return {
      fiveHour: {
        use: Math.round(body.five_hour.utilization),
        elapsed: elapsedPct(body.five_hour.resets_at, FIVE_HOUR_MS, now),
      },
      sevenDay: {
        use: Math.round(body.seven_day.utilization),
        elapsed: elapsedPct(body.seven_day.resets_at, SEVEN_DAY_MS, now),
      },
    };
  } catch {
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Profile fetch (email/display name). Bearer auth -> only call with a valid token.
// ---------------------------------------------------------------------------
export async function fetchProfile(oauth: OAuth): Promise<Profile | null> {
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return null;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      account?: { email?: string; display_name?: string; uuid?: string };
    };
    const acct = body.account;
    if (!acct) return null;
    return {
      email: acct.email ?? null,
      displayName: acct.display_name ?? null,
      uuid: acct.uuid ?? null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Display helpers (string-only)
// ---------------------------------------------------------------------------
export function tierLabel(oauth: OAuth): string {
  const tier = oauth.rateLimitTier ?? "";
  const map: Record<string, string> = {
    default_claude_max_20x: "Max 20x",
    default_claude_max_5x: "Max 5x",
    max_20x: "Max 20x",
    max_5x: "Max 5x",
    default_claude_pro: "Pro",
    pro: "Pro",
    free: "Free",
  };
  if (map[tier]) return map[tier];
  // Best-effort: strip known prefix, prettify.
  const stripped = tier.replace(/^default_claude_/, "").replace(/_/g, " ");
  if (stripped) {
    return stripped.replace(/\bmax\b/i, "Max").replace(/\b(\d+x)\b/, "$1");
  }
  return oauth.subscriptionType ?? "—";
}

export function expiresLabel(expiresAt: number): string {
  if (!expiresAt) return "—";
  const diff = expiresAt - Date.now();
  if (diff <= 0) return "expired";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `in ${days}d`;
}

export function accountLabel(slot: Slot): string {
  // Slot name is the identity (always shown); email is the optional extra.
  const email = slot.cache.email;
  return email ? `${slot.name} (${email})` : slot.name;
}
