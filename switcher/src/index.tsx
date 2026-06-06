import React, { useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput } from "ink";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  chmodSync,
} from "node:fs";
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

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const CLAUDE_DIR = join(homedir(), ".claude");
const ACTIVE_FILE = join(CLAUDE_DIR, ".credentials.json");
// Our single state file (Claude Code never reads it). Replaces the old
// .active-account pointer: holds the active slot + a per-slot profile cache.
const STATE_FILE = join(CLAUDE_DIR, ".credentials-switcher.json");
const SLOT_RE = /^\.(.+)\.credentials\.json$/;
const CRED_MODE = 0o600;

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const USAGE_HEADERS = {
  "anthropic-beta": "oauth-2025-04-20",
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type OAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

type CredFile = { claudeAiOauth: OAuth };

type Window = { use: number; elapsed: number };
type Usage = { fiveHour: Window; sevenDay: Window } | "loading" | "error";

type AccountCache = {
  email: string | null;
  displayName: string | null;
  org: string | null;
  uuid?: string | null;
  lastUsageAt?: number | null;
  inRotation: boolean;
  score?: number | null;
};

type SwitcherState = {
  active: string | null;
  accounts: Record<string, AccountCache>;
  lastAutoSwitchAt?: number | null;
};

type Slot = {
  name: string;
  path: string;
  oauth: OAuth;
  usage: Usage;
  cache: AccountCache;
};

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";

function emptyCache(): AccountCache {
  return {
    email: null,
    displayName: null,
    org: null,
    uuid: null,
    lastUsageAt: null,
    inRotation: true,
    score: null,
  };
}

// ---------------------------------------------------------------------------
// Slot discovery
// ---------------------------------------------------------------------------
function slotPath(name: string): string {
  return join(CLAUDE_DIR, `.${name}.credentials.json`);
}

function readOAuth(path: string): OAuth {
  const data = JSON.parse(readFileSync(path, "utf8")) as CredFile;
  return data.claudeAiOauth;
}

function discoverSlots(): Slot[] {
  const entries = readdirSync(CLAUDE_DIR);
  const slots: Slot[] = [];
  for (const entry of entries) {
    if (entry === ".credentials.json") continue;
    const m = entry.match(SLOT_RE);
    if (!m) continue;
    const name = m[1];
    const path = join(CLAUDE_DIR, entry);
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
// State file (.credentials-switcher.json) — our single source of switcher state
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

/** Read+validate the state file. Missing/malformed -> empty default. */
function readState(): SwitcherState {
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const obj = raw as Partial<SwitcherState>;
      const accounts: Record<string, AccountCache> = {};
      if (obj.accounts && typeof obj.accounts === "object") {
        for (const [name, c] of Object.entries(obj.accounts)) {
          const cc = (c ?? {}) as Partial<AccountCache>;
          accounts[name] = {
            email: cc.email ?? null,
            displayName: cc.displayName ?? null,
            org: cc.org ?? null,
            uuid: cc.uuid ?? null,
            lastUsageAt: cc.lastUsageAt ?? null,
            // Default in-rotation TRUE when the flag is absent.
            inRotation: cc.inRotation === undefined ? true : !!cc.inRotation,
            score: cc.score ?? null,
          };
        }
      }
      return {
        active: typeof obj.active === "string" ? obj.active : null,
        accounts,
        lastAutoSwitchAt:
          typeof obj.lastAutoSwitchAt === "number" ? obj.lastAutoSwitchAt : null,
      };
    }
  } catch {
    // missing or malformed -> default below
  }
  return { active: null, accounts: {}, lastAutoSwitchAt: null };
}

function writeState(state: SwitcherState): void {
  atomicWriteBuffer(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Resolve active slot + reconcile the state file against the slots on disk.
 * - active: from state.active if it still exists; else byte-compare and self-heal.
 * - accounts: prune missing slots, add entries for new slots (preserving caches).
 * Returns the (possibly updated) state, which is written back if it changed.
 */
function loadState(slots: Slot[]): SwitcherState {
  const state = readState();
  const names = new Set(slots.map((s) => s.name));

  // Reconcile accounts: keep existing caches, add new, drop gone.
  const accounts: Record<string, AccountCache> = {};
  for (const s of slots) {
    accounts[s.name] = state.accounts[s.name] ?? emptyCache();
  }

  // Resolve active.
  let active: string | null = null;
  if (state.active && names.has(state.active)) {
    active = state.active;
  } else if (existsSync(ACTIVE_FILE)) {
    for (const s of slots) {
      if (bytesEqual(ACTIVE_FILE, s.path)) {
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
      writeState(next);
    } catch {
      // non-fatal: UI still works from in-memory state
    }
  }
  return next;
}

/** Update the active field in the state file (read-modify-write, atomic). */
function setActiveInState(name: string | null): void {
  const state = readState();
  state.active = name;
  writeState(state);
}

/** Merge a profile into the cache for one slot, never clobbering with nulls. */
function cacheProfile(
  name: string,
  profile: { email?: string | null; displayName?: string | null; uuid?: string | null },
): void {
  const state = readState();
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = {
    ...cur,
    email: profile.email ?? cur.email,
    displayName: profile.displayName ?? cur.displayName,
    uuid: profile.uuid ?? cur.uuid ?? null,
  };
  writeState(state);
}

/** Toggle inRotation for a slot, persist immediately, return new value. */
function toggleRotationInState(name: string): boolean {
  const state = readState();
  const cur = state.accounts[name] ?? emptyCache();
  const next = !(cur.inRotation ?? true);
  state.accounts[name] = { ...cur, inRotation: next };
  writeState(state);
  return next;
}

/** Cache usage score + lastUsageAt for a slot. */
function cacheUsageInState(name: string, score: number | null, at: number): void {
  const state = readState();
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = { ...cur, score, lastUsageAt: at };
  writeState(state);
}

function setLastAutoSwitchAt(at: number): void {
  const state = readState();
  state.lastAutoSwitchAt = at;
  writeState(state);
}

// ---------------------------------------------------------------------------
// Atomic writes (same-dir temp + rename, mode 0600)
// ---------------------------------------------------------------------------
function atomicCopy(src: string, dst: string): void {
  const data = readFileSync(src);
  atomicWriteBuffer(dst, data);
}

function atomicWriteBuffer(dst: string, data: Buffer | string): void {
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, data, { mode: CRED_MODE });
  chmodSync(tmp, CRED_MODE);
  renameSync(tmp, dst);
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
    const state = readState();
    state.active = target;
    if (stampAutoSwitchAt !== undefined) state.lastAutoSwitchAt = stampAutoSwitchAt;
    writeState(state);
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
// Usage fetch
// ---------------------------------------------------------------------------
function elapsedPct(resetsAtIso: string, windowMs: number, now: number): number {
  const resetsAt = new Date(resetsAtIso).getTime();
  if (!Number.isFinite(resetsAt)) return 0;
  const elapsed = 1 - (resetsAt - now) / windowMs;
  return Math.max(0, Math.min(100, Math.round(elapsed * 100)));
}

async function fetchUsage(oauth: OAuth): Promise<Usage> {
  // Skip a guaranteed-failing call for already-expired tokens.
  if (oauth.expiresAt && oauth.expiresAt < Date.now()) return "error";
  try {
    const res = await fetch(USAGE_URL, {
      headers: { ...USAGE_HEADERS, Authorization: `Bearer ${oauth.accessToken}` },
    });
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
type Profile = { email: string | null; displayName: string | null; uuid: string | null };

async function fetchProfile(oauth: OAuth): Promise<Profile | null> {
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
// Display helpers
// ---------------------------------------------------------------------------
function tierLabel(oauth: OAuth): string {
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

function expiresLabel(expiresAt: number): string {
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

// ---------------------------------------------------------------------------
// Layout: columns are plain strings except Usage which is built from fragments.
// We compute widths over the plain-text length of every cell so the box stays
// aligned, then render colored fragments padded to that width.
// ---------------------------------------------------------------------------
type Fragment = { text: string; color?: string };

type DisplayRow = {
  name: string;
  inRotation: boolean;
  cells: {
    account: string;
    active: string;
    rotation: string;
    tier: string;
    usage: Fragment[];
    expires: string;
  };
};

const HEADERS = {
  account: "Account",
  active: "Active",
  rotation: "Rot",
  tier: "Tier",
  usage: "Usage",
  expires: "Expires",
};
const COL_ORDER: (keyof typeof HEADERS)[] = [
  "account",
  "active",
  "rotation",
  "tier",
  "usage",
  "expires",
];

function fragLen(frags: Fragment[]): number {
  return frags.reduce((n, f) => n + f.text.length, 0);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - text.length));
}

function buildUsageFragments(usage: Usage): Fragment[] {
  if (usage === "loading") return [{ text: "…" }];
  if (usage === "error") return [{ text: "—" }];
  const win = (w: Window): Fragment[] => [
    { text: `${w.use}%`, color: w.use > w.elapsed ? "red" : "green" },
    { text: `/${w.elapsed}%` },
  ];
  return [
    { text: "5h: " },
    ...win(usage.fiveHour),
    { text: "  7d: " },
    ...win(usage.sevenDay),
  ];
}

function accountLabel(slot: Slot): string {
  // Slot name is the identity (always shown); email is the optional extra.
  const email = slot.cache.email;
  return email ? `${slot.name} (${email})` : slot.name;
}

function buildRows(slots: Slot[], active: string | null): DisplayRow[] {
  return slots.map((s) => {
    const inRotation = s.cache.inRotation !== false;
    return {
      name: s.name,
      inRotation,
      cells: {
        account: accountLabel(s),
        active: s.name === active ? "●" : "",
        rotation: inRotation ? "◉" : "○",
        tier: tierLabel(s.oauth),
        usage: buildUsageFragments(s.usage),
        expires: expiresLabel(s.oauth.expiresAt),
      },
    };
  });
}

function computeWidths(rows: DisplayRow[]): Record<keyof typeof HEADERS, number> {
  const w = {} as Record<keyof typeof HEADERS, number>;
  for (const col of COL_ORDER) {
    let max = HEADERS[col].length;
    for (const r of rows) {
      const cell = r.cells[col];
      const len = col === "usage" ? fragLen(cell as Fragment[]) : (cell as string).length;
      max = Math.max(max, len);
    }
    w[col] = max;
  }
  return w;
}

// ---------------------------------------------------------------------------
// Slot hydration: attach cached profile from the state file to each slot.
// ---------------------------------------------------------------------------
function hydrateSlots(slots: Slot[], state: SwitcherState): Slot[] {
  return slots.map((s) => ({ ...s, cache: state.accounts[s.name] ?? emptyCache() }));
}

function loadAll(): { slots: Slot[]; active: string | null } {
  const raw = discoverSlots();
  const state = loadState(raw);
  return { slots: hydrateSlots(raw, state), active: state.active };
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
    return discoverSlots().map((s) => s.name);
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
      cacheProfile(active, profile);
      setSlots((prev) =>
        prev.map((s) =>
          s.name === active
            ? {
                ...s,
                cache: {
                  ...s.cache,
                  email: profile.email ?? s.cache.email,
                  displayName: profile.displayName ?? s.cache.displayName,
                  uuid: profile.uuid ?? s.cache.uuid ?? null,
                },
              }
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
    cacheProfile(name, profile);
    setSlots((prev) =>
      prev.map((s) =>
        s.name === name
          ? {
              ...s,
              cache: {
                ...s.cache,
                email: profile.email ?? s.cache.email,
                displayName: profile.displayName ?? s.cache.displayName,
                uuid: profile.uuid ?? s.cache.uuid ?? null,
              },
            }
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
      setSlots((prev) =>
        prev.map((s) =>
          s.name === name ? { ...s, oauth: fresh, usage: "loading" } : s,
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
      const { slots: fresh, active: newActive } = loadAll();
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
      if (profile) cacheProfile(label, profile);
      const { slots: fresh, active: newActive } = loadAll();
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
      }));

      const results = await runUsagePass(passAccounts, now, forceAll, {
        refreshIfExpired: async (name) => {
          const slot = slotsRef.current.find((s) => s.name === name);
          if (!slot) return null;
          const fresh = await refreshAccount(name, slot.oauth, false);
          setSlots((prev) =>
            prev.map((s) => (s.name === name ? { ...s, oauth: fresh } : s)),
          );
          return { expiresAt: fresh.expiresAt };
        },
        fetchUsage: async (name) => {
          // Use the freshest oauth (a refresh this pass may have updated it).
          const slot = slotsRef.current.find((s) => s.name === name);
          return fetchUsage(slot ? slot.oauth : cur.find((s) => s.name === name)!.oauth);
        },
      });

      // Apply results: update table + cache score/lastUsageAt for fetched rows.
      const at = Date.now();
      for (const r of results) {
        if (!r.fetched) continue; // failures keep prior value
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
        const state = readState();
        const decision = decideAutoSwitch({
          accounts,
          active: activeRef.current,
          lastAutoSwitchAt: state.lastAutoSwitchAt ?? null,
          now: Date.now(),
        });
        if (decision.target) {
          const from = activeRef.current;
          await performSwitchSafe(decision.target, from, Date.now());
          const { slots: reloaded, active: newActive } = loadAll();
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
function main(): void {
  // No credentials at all → friendly message, exit cleanly.
  if (!existsSync(ACTIVE_FILE) && discoverSlots().length === 0) {
    console.error("No Claude credentials found — run `claude` and log in first.");
    process.exit(0);
  }

  const initial = loadAll();

  // Onboarding only when there's an active credentials file that matches no
  // slot AND we couldn't resolve an active slot (genuinely untracked).
  const hasActiveFile = existsSync(ACTIVE_FILE);
  const needsOnboarding = hasActiveFile && initial.active === null;

  render(<App initial={initial} needsOnboarding={needsOnboarding} />);
}

main();
