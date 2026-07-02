import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { readFileSync, existsSync, chmodSync } from "node:fs";
import lockfile from "proper-lockfile";
import {
  refreshOAuth,
  atomicWriteCred,
  RefreshError,
  type FetchLike,
} from "./refresh";
import {
  suggestLabelFromEmail,
  validateLabel,
  saveActiveToSlot,
} from "./onboard";
import {
  decideAutoSwitch,
  usageScore,
  runUsagePass,
  remainingSeconds,
  USAGE_REFRESH_MS,
  type BalanceAccount,
  type PassAccount,
} from "./balance";
import {
  readState,
  writeState,
  emptyCache,
  atomicWriteBuffer,
  type Paths,
  type AccountCache,
} from "./credstore";
import {
  paths,
  claudeDir,
  discoverSlots,
  loadAll,
  fetchUsage,
  fetchProfile,
  readOAuth,
  mergeProfileIntoCache,
  identityFingerprint,
  CRED_MODE,
  type OAuth,
  type Usage,
  type Slot,
  type Profile,
} from "./core";
import {
  buildRows,
  computeWidths,
  fragLen,
  pad,
  HEADERS,
  COL_ORDER,
  type DisplayRow,
} from "./table";
import { runCli } from "./cli";

// ---------------------------------------------------------------------------
// Paths (env-aware; resolved once for the TUI process).
// ---------------------------------------------------------------------------
const PATHS: Paths = paths();
const CLAUDE_DIR = claudeDir();
const ACTIVE_FILE = PATHS.active;

function slotPath(name: string): string {
  return PATHS.slot(name);
}

// ---------------------------------------------------------------------------
// State mutators (TUI-internal; read-modify-write of the state file)
// ---------------------------------------------------------------------------
/** Update the active field in the state file (read-modify-write, atomic). */
function setActiveInState(name: string | null): void {
  const state = readState(PATHS);
  state.active = name;
  writeState(PATHS, state);
}

/**
 * Merge a profile into the cache for one slot. Self-corrects on a uuid change
 * (a different account in this slot replaces the identity) and stamps the
 * slot's identity fingerprint so a later load trusts the cache. Pass the slot's
 * current oauth so the fingerprint matches the live token.
 */
function cacheProfile(
  name: string,
  profile: { email?: string | null; displayName?: string | null; uuid?: string | null },
  oauth: OAuth,
): void {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = mergeProfileIntoCache(cur, profile, oauth);
  writeState(PATHS, state);
}

/** Toggle inRotation for a slot, persist immediately, return new value. */
function toggleRotationInState(name: string): boolean {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  const next = !(cur.inRotation ?? true);
  state.accounts[name] = { ...cur, inRotation: next };
  writeState(PATHS, state);
  return next;
}

/** Cache usage score + lastUsageAt for a slot. */
function cacheUsageInState(name: string, score: number | null, at: number): void {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = { ...cur, score, lastUsageAt: at };
  writeState(PATHS, state);
}

/** Record a refresh failure for a slot (increments backoff counter). */
function recordRefreshFailureInState(name: string, at: number): void {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = {
    ...cur,
    refreshFailures: (cur.refreshFailures ?? 0) + 1,
    lastRefreshFailAt: at,
  };
  writeState(PATHS, state);
}

/** Clear refresh-failure backoff for a slot after a successful refresh. */
function clearRefreshFailureInState(name: string): void {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  if (!cur.refreshFailures && !cur.lastRefreshFailAt) return;
  state.accounts[name] = { ...cur, refreshFailures: 0, lastRefreshFailAt: null };
  writeState(PATHS, state);
}

/**
 * Restamp a slot's identity fingerprint to its current token. Called after an
 * in-place token refresh (same account, rotated token) so the rotated token
 * still matches the cached identity and a later load does NOT wrongly clear the
 * email. Identity (email/uuid) is unchanged.
 */
function restampFingerprintInState(name: string, oauth: OAuth): void {
  const state = readState(PATHS);
  const cur = state.accounts[name] ?? emptyCache();
  const fp = identityFingerprint(oauth);
  if (cur.identityFingerprint === fp) return;
  state.accounts[name] = { ...cur, identityFingerprint: fp };
  writeState(PATHS, state);
}

// ---------------------------------------------------------------------------
// Atomic credential copy (same-dir temp + rename, mode 0600)
// ---------------------------------------------------------------------------
function atomicCopy(src: string, dst: string): void {
  const data = readFileSync(src);
  atomicWriteBuffer(dst, data);
}

/**
 * Switch the active account to `target`.
 * 1. Save current active back to the current active's slot (capture rotated tokens).
 * 2. Copy target slot -> active.
 * 3. Update active in the state file.
 */
function performSwitch(target: string, currentActive: string | null): void {
  if (currentActive && currentActive !== target) {
    // Save current active creds back to its slot (refresh-token rotation safety).
    atomicCopy(ACTIVE_FILE, slotPath(currentActive));
  }
  atomicCopy(slotPath(target), ACTIVE_FILE);
  // Ensure active file keeps 0600.
  chmodSync(ACTIVE_FILE, CRED_MODE);
  setActiveInState(target);
}

/**
 * Lock-wrapped switch used by the auto-balancer. Reads the LIVE
 * .credentials.json at switch-out time (Claude Code may have rotated tokens)
 * and saves THOSE bytes to the outgoing slot, all under a proper-lockfile lock
 * on ~/.claude to avoid racing Claude Code's own refresh. Atomic 0600 writes.
 */
async function performSwitchSafe(
  target: string,
  currentActive: string | null,
  stampAutoSwitchAt?: number,
): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(CLAUDE_DIR, {
      retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
      stale: 10000,
    });
  } catch {
    release = null; // best-effort
  }
  try {
    if (currentActive && currentActive !== target && existsSync(ACTIVE_FILE)) {
      // LIVE read of the active file -> outgoing slot (captures token rotation).
      atomicCopy(ACTIVE_FILE, slotPath(currentActive));
    }
    atomicCopy(slotPath(target), ACTIVE_FILE);
    chmodSync(ACTIVE_FILE, CRED_MODE);
    const state = readState(PATHS);
    state.active = target;
    if (stampAutoSwitchAt !== undefined) state.lastAutoSwitchAt = stampAutoSwitchAt;
    writeState(PATHS, state);
  } finally {
    if (release) await release().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Token refresh orchestration
// ---------------------------------------------------------------------------
// Real fetch wired to the injectable FetchLike signature.
const realFetch: FetchLike = (input, init) =>
  fetch(input, init) as ReturnType<FetchLike>;

/**
 * Refresh a single account's token and persist it.
 * - inactive slot: write only the slot file (Claude Code never touches it).
 * - active account: lock ~/.claude (matching Claude Code's proper-lockfile use)
 *   then write BOTH the active file and its slot so they stay in sync.
 * Returns the refreshed OAuth. Throws on failure (files left untouched).
 */
async function refreshAccount(
  name: string,
  oauth: OAuth,
  isActive: boolean,
): Promise<OAuth> {
  const fresh = await refreshOAuth(oauth, realFetch);
  if (!isActive) {
    atomicWriteCred(slotPath(name), fresh);
    return fresh;
  }
  // Active: take the same lock Claude Code uses, then write active + slot.
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(CLAUDE_DIR, {
      retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
      stale: 10000,
    });
  } catch {
    release = null; // best-effort lock; proceed if dir can't be locked
  }
  try {
    atomicWriteCred(ACTIVE_FILE, fresh);
    atomicWriteCred(slotPath(name), fresh);
  } finally {
    if (release) await release().catch(() => {});
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Minimal controlled text input (hand-rolled to avoid extra deps under Bun).
// ---------------------------------------------------------------------------
const TextInput: React.FC<{ value: string; onChange: (v: string) => void }> = ({
  value,
  onChange,
}) => {
  useInput((input, key) => {
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta && !key.return && !key.escape) {
      // Append printable chars (filter control chars).
      const clean = input.replace(/[\x00-\x1f]/g, "");
      if (clean) onChange(value + clean);
    }
  });
  return (
    <Text>
      {value}
      <Text inverse> </Text>
    </Text>
  );
};

// ---------------------------------------------------------------------------
// Onboarding view: name an untracked active account into a slot.
// ---------------------------------------------------------------------------
const Onboarding: React.FC<{
  suggestion: string;
  fetchedProfile: Profile | null;
  onConfirm: (label: string, profile: Profile | null) => void;
  onSkip: () => void;
}> = ({ suggestion, fetchedProfile, onConfirm, onSkip }) => {
  const [value, setValue] = useState(suggestion);
  const [error, setError] = useState<string | null>(null);

  useInput((_input, key) => {
    if (key.return) {
      const v = validateLabel(value, listSlotNamesSafe());
      if (v.ok) onConfirm(value, fetchedProfile);
      else setError(v.reason);
    } else if (key.escape) {
      onSkip();
    } else {
      if (error) setError(null);
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Welcome to claude-throttle account switcher
      </Text>
      <Box marginTop={1}>
        <Text>
          Current account isn&apos;t saved yet
          {fetchedProfile?.email ? ` (${fetchedProfile.email})` : ""} — name this slot:{" "}
        </Text>
        <TextInput value={value} onChange={setValue} />
      </Box>
      {error && (
        <Box>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Enter to save · Esc to skip (continue as &quot;unknown&quot;)</Text>
      </Box>
    </Box>
  );
};

function listSlotNamesSafe(): string[] {
  try {
    return discoverSlots(PATHS).map((s) => s.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
type AppProps = {
  initial: { slots: Slot[]; active: string | null };
  needsOnboarding: boolean;
};

const App: React.FC<AppProps> = ({ initial, needsOnboarding }) => {
  const { exit } = useApp();
  const [phase, setPhase] = useState<"onboarding" | "table">(
    needsOnboarding ? "onboarding" : "table",
  );
  const [slots, setSlots] = useState<Slot[]>(initial.slots);
  const [active, setActive] = useState<string | null>(initial.active);
  const [selected, setSelected] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Auto-balance mode (default OFF). lastAction surfaces what the balancer did.
  const [autoBalance, setAutoBalance] = useState(false);
  // All-accounts usage auto-refresh at a fixed 30s cadence (the `u` toggle, default OFF).
  const [usageRefresh, setUsageRefresh] = useState(false);
  // Timestamp the next scheduled usage-refresh pass is due (for the countdown
  // display only — the real fetch stays on its 30s interval).
  const [nextRefreshAt, setNextRefreshAt] = useState<number | null>(null);
  // Re-render driver for the 1s countdown tick.
  const [countdownNow, setCountdownNow] = useState(() => Date.now());
  const [lastAction, setLastAction] = useState<string | null>(null);

  // Refs so the polling loop always sees current state (no stale closures).
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  const activeRef = useRef(active);
  activeRef.current = active;
  const autoBalanceRef = useRef(autoBalance);
  autoBalanceRef.current = autoBalance;
  const usageRefreshRef = useRef(usageRefresh);
  usageRefreshRef.current = usageRefresh;
  const busyRef = useRef(false); // guard against overlapping ticks

  // Onboarding: fetch the active account's profile to suggest a label.
  const [onboardProfile, setOnboardProfile] = useState<Profile | null>(null);
  const [onboardSuggestion, setOnboardSuggestion] = useState<string>("default");
  const [onboardReady, setOnboardReady] = useState(!needsOnboarding);

  useEffect(() => {
    if (!needsOnboarding) return;
    let cancelled = false;
    (async () => {
      let profile: Profile | null = null;
      try {
        const oauth = readOAuth(ACTIVE_FILE);
        profile = await fetchProfile(oauth);
      } catch {
        profile = null;
      }
      if (cancelled) return;
      setOnboardProfile(profile);
      setOnboardSuggestion(suggestLabelFromEmail(profile?.email));
      setOnboardReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [needsOnboarding]);

  // Fetch usage for every slot independently; fill in as each resolves.
  useEffect(() => {
    if (phase !== "table") return;
    let cancelled = false;
    for (const slot of slots) {
      void fetchUsage(slot.oauth).then((usage) => {
        if (cancelled) return;
        setSlots((prev) =>
          prev.map((s) => (s.name === slot.name ? { ...s, usage } : s)),
        );
      });
    }
    return () => {
      cancelled = true;
    };
    // Keyed on reloadNonce so a post-switch reload re-fetches usage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadNonce, phase]);

  // On entering the table, fetch the active account's profile (valid token)
  // and cache its email.
  useEffect(() => {
    if (phase !== "table" || !active) return;
    let cancelled = false;
    const slot = slots.find((s) => s.name === active);
    if (!slot) return;
    // Skip if we already have a cached email for the active slot.
    if (slot.cache.email) return;
    void fetchProfile(slot.oauth).then((profile) => {
      if (cancelled || !profile) return;
      cacheProfile(active, profile, slot.oauth);
      setSlots((prev) =>
        prev.map((s) =>
          s.name === active
            ? { ...s, cache: mergeProfileIntoCache(s.cache, profile, s.oauth) }
            : s,
        ),
      );
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, active, reloadNonce]);

  /** After a token becomes valid (refresh/switch), fetch + cache the profile. */
  async function refreshProfileFor(name: string, oauth: OAuth): Promise<void> {
    const profile = await fetchProfile(oauth);
    if (!profile) return;
    cacheProfile(name, profile, oauth);
    setSlots((prev) =>
      prev.map((s) =>
        s.name === name
          ? { ...s, cache: mergeProfileIntoCache(s.cache, profile, oauth) }
          : s,
      ),
    );
  }

  /** Refresh one account's token, then re-fetch its usage + profile. */
  async function doRefresh(name: string): Promise<void> {
    const slot = slots.find((s) => s.name === name);
    if (!slot) return;
    setFlash(`refreshing ${name}…`);
    try {
      const fresh = await refreshAccount(name, slot.oauth, name === active);
      // Rotated token, same account -> keep the cached identity valid.
      restampFingerprintInState(name, fresh);
      setSlots((prev) =>
        prev.map((s) =>
          s.name === name
            ? {
                ...s,
                oauth: fresh,
                usage: "loading",
                cache: { ...s.cache, identityFingerprint: identityFingerprint(fresh) },
              }
            : s,
        ),
      );
      const usage = await fetchUsage(fresh);
      setSlots((prev) =>
        prev.map((s) => (s.name === name ? { ...s, usage } : s)),
      );
      setFlash(`refreshed ${name}`);
      // Token is now valid → pull profile/email.
      void refreshProfileFor(name, fresh);
    } catch (e) {
      const reason =
        e instanceof RefreshError ? e.message : (e as Error).message;
      setFlash(`refresh failed: ${reason}`);
    }
  }

  function doSwitch(target: string): void {
    if (target === active) return; // no-op on already-active row
    try {
      performSwitch(target, active);
      setFlash(`switched → ${target}`);
      const { slots: fresh, active: newActive } = loadAll(PATHS);
      setSlots(fresh);
      setActive(newActive);
      setReloadNonce((n) => n + 1);
      // Auto-refresh on switch if the now-active token is expired.
      const targetSlot = fresh.find((s) => s.name === target);
      if (targetSlot && targetSlot.oauth.expiresAt < Date.now()) {
        void doRefresh(target);
      }
    } catch (e) {
      setFlash(`switch failed: ${(e as Error).message}`);
    }
  }

  function onOnboardConfirm(label: string, profile: Profile | null): void {
    try {
      saveActiveToSlot(CLAUDE_DIR, label);
      setActiveInState(label);
      if (profile) cacheProfile(label, profile, readOAuth(slotPath(label)));
      const { slots: fresh, active: newActive } = loadAll(PATHS);
      setSlots(fresh);
      setActive(newActive);
      setPhase("table");
      setReloadNonce((n) => n + 1);
      setFlash(`saved current account as "${label}"`);
    } catch (e) {
      setFlash(`save failed: ${(e as Error).message}`);
      setPhase("table");
    }
  }

  function onOnboardSkip(): void {
    setPhase("table");
    setReloadNonce((n) => n + 1);
  }

  /** Toggle in/out of rotation for a slot; persist + update in-memory. */
  function toggleRotation(name: string): void {
    const next = toggleRotationInState(name);
    setSlots((prev) =>
      prev.map((s) =>
        s.name === name ? { ...s, cache: { ...s.cache, inRotation: next } } : s,
      ),
    );
    setFlash(`${name}: ${next ? "in" : "out of"} rotation`);
  }

  // --- Unified polling tick -------------------------------------------------
  // A SINGLE driver feeds both features so they never double-fetch:
  //   1) runUsagePass over all accounts. forceAll = usage-refresh ON, so the
  //      whole table goes live at the 30s cadence. When only auto-balance is
  //      ON, the pass self-gates per account (active ~60s, in-rotation
  //      inactive ~5m, out-of-rotation skipped). Token refresh happens only
  //      for expired/near-expiry, non-active accounts — never every tick.
  //   2) auto-balance decision (only when ON) consumes those fresh scores.
  async function tick(): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const now = Date.now();
      const cur = slotsRef.current;
      const act = activeRef.current;
      const forceAll = usageRefreshRef.current;

      // A pass is firing now; the next one is one cadence away. Used only by
      // the countdown display (fetch timing is unchanged).
      if (forceAll) setNextRefreshAt(now + USAGE_REFRESH_MS);

      // 1) One usage-refresh pass for the whole table.
      const passAccounts: PassAccount<Usage>[] = cur.map((s) => ({
        name: s.name,
        isActive: s.name === act,
        inRotation: s.cache.inRotation !== false,
        expiresAt: s.oauth.expiresAt,
        lastUsageAt: s.cache.lastUsageAt ?? null,
        usage: s.usage,
        refreshFailures: s.cache.refreshFailures ?? 0,
        lastRefreshFailAt: s.cache.lastRefreshFailAt ?? null,
      }));

      const results = await runUsagePass(passAccounts, now, forceAll, {
        refreshIfExpired: async (name) => {
          const slot = slotsRef.current.find((s) => s.name === name);
          if (!slot) return null;
          // Throws on failure -> runUsagePass marks refreshFailed.
          const fresh = await refreshAccount(name, slot.oauth, false);
          // Rotated token, same account -> keep the cached identity valid.
          restampFingerprintInState(name, fresh);
          setSlots((prev) =>
            prev.map((s) =>
              s.name === name
                ? {
                    ...s,
                    oauth: fresh,
                    cache: { ...s.cache, identityFingerprint: identityFingerprint(fresh) },
                  }
                : s,
            ),
          );
          return { expiresAt: fresh.expiresAt };
        },
        fetchUsage: async (name) => {
          // Use the freshest oauth (a refresh this pass may have updated it).
          const slot = slotsRef.current.find((s) => s.name === name);
          return fetchUsage(slot ? slot.oauth : cur.find((s) => s.name === name)!.oauth);
        },
        // "error"/"loading" are transient -> don't clobber the prior good value.
        isError: (u) => u === "error" || u === "loading",
      });

      // Apply results.
      const at = Date.now();
      for (const r of results) {
        // Update refresh-failure backoff bookkeeping (state file + in-memory),
        // independent of whether the usage fetch then succeeded.
        if (r.refreshed) {
          clearRefreshFailureInState(r.name);
          setSlots((prev) =>
            prev.map((s) =>
              s.name === r.name
                ? { ...s, cache: { ...s.cache, refreshFailures: 0, lastRefreshFailAt: null } }
                : s,
            ),
          );
        } else if (r.refreshFailed) {
          recordRefreshFailureInState(r.name, at);
          setSlots((prev) =>
            prev.map((s) =>
              s.name === r.name
                ? {
                    ...s,
                    cache: {
                      ...s.cache,
                      refreshFailures: (s.cache.refreshFailures ?? 0) + 1,
                      lastRefreshFailAt: at,
                    },
                  }
                : s,
            ),
          );
        }

        if (!r.fetched) continue; // transient failure: keep prior value (no clobber)
        const score = usageScore(r.usage);
        cacheUsageInState(r.name, score, at);
        setSlots((prev) =>
          prev.map((s) =>
            s.name === r.name
              ? { ...s, usage: r.usage, cache: { ...s.cache, score, lastUsageAt: at } }
              : s,
          ),
        );
      }

      // 2) Auto-balance decision (only when that mode is ON).
      if (autoBalanceRef.current) {
        const fresh = slotsRef.current;
        const accounts: BalanceAccount[] = fresh.map((s) => ({
          name: s.name,
          inRotation: s.cache.inRotation !== false,
          score: usageScore(s.usage),
        }));
        const state = readState(PATHS);
        const decision = decideAutoSwitch({
          accounts,
          active: activeRef.current,
          lastAutoSwitchAt: state.lastAutoSwitchAt ?? null,
          now: Date.now(),
        });
        if (decision.target) {
          const from = activeRef.current;
          await performSwitchSafe(decision.target, from, Date.now());
          const { slots: reloaded, active: newActive } = loadAll(PATHS);
          setSlots(reloaded);
          setActive(newActive);
          setReloadNonce((n) => n + 1);
          setLastAction(
            `auto-switched ${from}→${decision.target} (${decision.activeScore}%→${decision.candidateScore}%)`,
          );
        }
      }
    } finally {
      busyRef.current = false;
    }
  }

  // Single interval driver. Runs while EITHER mode is ON. Cadence is the 30s
  // usage-refresh rate when `u` is ON, else a 30s base poll for auto-balance
  // (its per-account gates decide what actually re-fetches).
  useEffect(() => {
    if (phase !== "table" || (!autoBalance && !usageRefresh)) return;
    let cancelled = false;
    const period = usageRefresh ? USAGE_REFRESH_MS : 30_000;
    void tick();
    const id = setInterval(() => {
      if (!cancelled) void tick();
    }, period);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBalance, usageRefresh, phase]);

  // Lightweight 1s display tick that re-renders the countdown. Only runs while
  // usage-refresh is ON (no idle 1s re-render otherwise). Display-only.
  useEffect(() => {
    if (phase !== "table" || !usageRefresh) return;
    setCountdownNow(Date.now()); // immediate update on toggle-on
    const id = setInterval(() => setCountdownNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [usageRefresh, phase]);

  useInput(
    (input, key) => {
      if (key.upArrow || input === "k") {
        setSelected((s) => (s - 1 + slots.length) % slots.length);
      } else if (key.downArrow || input === "j") {
        setSelected((s) => (s + 1) % slots.length);
      } else if (key.return) {
        const target = slots[selected];
        if (target) doSwitch(target.name);
      } else if (input === "r") {
        const row = slots[selected];
        if (row) void doRefresh(row.name);
      } else if (input === " ") {
        const row = slots[selected];
        if (row) toggleRotation(row.name);
      } else if (input === "a") {
        setAutoBalance((v) => {
          const next = !v;
          setFlash(`auto-balance: ${next ? "ON" : "OFF"}`);
          return next;
        });
      } else if (input === "u") {
        setUsageRefresh((v) => {
          const next = !v;
          if (next) {
            // Seed the countdown immediately so it shows the full window, not
            // 0s, before the first async pass sets nextRefreshAt.
            const seed = Date.now();
            setCountdownNow(seed);
            setNextRefreshAt(seed + USAGE_REFRESH_MS);
          } else {
            setNextRefreshAt(null);
          }
          setFlash(
            next ? `usage-refresh: ON (${Math.round(USAGE_REFRESH_MS / 1000)}s)` : "usage-refresh: OFF",
          );
          return next;
        });
      } else if (input === "q" || key.escape || (key.ctrl && input === "c")) {
        exit();
      }
    },
    { isActive: phase === "table" },
  );

  if (phase === "onboarding") {
    if (!onboardReady) {
      return (
        <Box>
          <Text dimColor>Checking current account…</Text>
        </Box>
      );
    }
    return (
      <Onboarding
        suggestion={onboardSuggestion}
        fetchedProfile={onboardProfile}
        onConfirm={onOnboardConfirm}
        onSkip={onOnboardSkip}
      />
    );
  }

  const rows = buildRows(slots, active);
  const widths = computeWidths(rows);

  // Two-char cursor gutter to the left of the box, so the selected row is
  // marked without inverting the whole line (keeps the colored % visible).
  const GUTTER = "  ";

  const horizontal = (left: string, mid: string, right: string) =>
    GUTTER +
    left +
    COL_ORDER.map((c) => "─".repeat(widths[c] + 2)).join(mid) +
    right;

  const headerLine =
    GUTTER +
    "│ " +
    COL_ORDER.map((c) => pad(HEADERS[c], widths[c])).join(" │ ") +
    " │";

  const renderRow = (row: DisplayRow, isSelected: boolean) => {
    // Build the row as a sequence of <Text> fragments so the Usage cell keeps
    // its per-fragment colors. The selected row is marked with a cyan "›"
    // cursor in the gutter + a bold account name — no row-wide inverse.
    // Out-of-rotation rows are dimmed (except the colored usage %).
    const dim = !row.inRotation;
    const parts: React.ReactNode[] = [];
    let k = 0;
    const push = (
      text: string,
      opts: { color?: string; bold?: boolean; dimColor?: boolean } = {},
    ) =>
      parts.push(
        <Text key={k++} color={opts.color} bold={opts.bold} dimColor={opts.dimColor}>
          {text}
        </Text>,
      );

    // Cursor gutter.
    if (isSelected) push("› ", { color: "cyan", bold: true });
    else push(GUTTER);

    push("│ ");
    COL_ORDER.forEach((c, i) => {
      if (c === "usage") {
        const frags = row.cells.usage;
        for (const f of frags) push(f.text, { color: f.color, dimColor: dim && !f.color });
        const padN = widths.usage - fragLen(frags);
        if (padN > 0) push(" ".repeat(padN));
      } else if (c === "account") {
        push(pad(row.cells.account, widths.account), {
          color: isSelected ? "cyan" : undefined,
          bold: isSelected,
          dimColor: dim && !isSelected,
        });
      } else if (c === "rotation") {
        // Green ◉ in rotation, dim ○ out.
        push(pad(row.cells.rotation, widths.rotation), {
          color: row.inRotation ? "green" : undefined,
          dimColor: !row.inRotation,
        });
      } else {
        push(pad(row.cells[c] as string, widths[c]), { dimColor: dim });
      }
      push(i < COL_ORDER.length - 1 ? " │ " : " │");
    });
    return (
      <Box key={row.name}>
        {parts}
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">
          Claude Credential Accounts
        </Text>
        {active === null && (
          <Text color="yellow">{"  (active account: unknown)"}</Text>
        )}
        <Text>{"   auto-balance: "}</Text>
        <Text bold color={autoBalance ? "green" : "gray"}>
          {autoBalance ? "ON" : "OFF"}
        </Text>
        <Text>{"   usage-refresh: "}</Text>
        <Text bold color={usageRefresh ? "green" : "gray"}>
          {usageRefresh
            ? `ON (${remainingSeconds(nextRefreshAt, countdownNow)}s)`
            : "OFF"}
        </Text>
      </Box>

      <Text>{horizontal("┌", "┬", "┐")}</Text>
      <Text bold>{headerLine}</Text>
      <Text>{horizontal("├", "┼", "┤")}</Text>

      {rows.map((row, i) => renderRow(row, i === selected))}

      <Text>{horizontal("└", "┴", "┘")}</Text>

      <Box marginTop={1}>
        <Text dimColor>
          ↑/↓ move · enter switch · space rotation · a auto-balance · u usage-refresh · r refresh · q quit
        </Text>
      </Box>
      <Box>
        <Text dimColor>legend: </Text>
        <Text color="green">◉</Text>
        <Text dimColor>in / </Text>
        <Text dimColor>○ out of rotation · </Text>
        <Text color="red">use%</Text>
        <Text dimColor>/elapsed% (red = ahead of pace)</Text>
      </Box>
      {lastAction && (
        <Box>
          <Text color="cyan">{lastAction}</Text>
        </Box>
      )}
      {flash && (
        <Box>
          <Text
            color={flash.startsWith("refresh failed") || flash.startsWith("switch failed") ? "red" : "green"}
          >
            {flash}
          </Text>
        </Box>
      )}
    </Box>
  );
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // CLI dispatch first. Non-null exit code => the CLI handled the invocation.
  const code = await runCli(process.argv.slice(2));
  if (code !== null) {
    process.exit(code);
  }

  // No args -> launch the TUI (unchanged behavior below).

  // No credentials at all → friendly message, exit cleanly.
  if (!existsSync(ACTIVE_FILE) && discoverSlots(PATHS).length === 0) {
    console.error("No Claude credentials found — run `claude` and log in first.");
    process.exit(0);
  }

  const initial = loadAll(PATHS);

  // Onboarding only when there's an active credentials file that matches no
  // slot AND we couldn't resolve an active slot (genuinely untracked).
  const hasActiveFile = existsSync(ACTIVE_FILE);
  const needsOnboarding = hasActiveFile && initial.active === null;

  render(<App initial={initial} needsOnboarding={needsOnboarding} />);
}

main();
