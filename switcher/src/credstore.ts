// Path-parameterized credential-store mechanics, isolated so the auto-switch
// file operations and rotation-flag persistence can be tested against a TEMP
// fake ~/.claude (never the real one).
import {
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";

const CRED_MODE = 0o600;

export type AccountCache = {
  email: string | null;
  displayName: string | null;
  org: string | null;
  uuid?: string | null;
  lastUsageAt?: number | null;
  inRotation?: boolean;
  score?: number | null;
  refreshFailures?: number;
  lastRefreshFailAt?: number | null;
};

export type SwitcherState = {
  active: string | null;
  accounts: Record<string, AccountCache>;
  lastAutoSwitchAt?: number | null;
};

export type Paths = {
  dir: string; // the .claude dir
  active: string; // .credentials.json
  state: string; // .credentials-switcher.json
  slot: (name: string) => string;
};

export function makePaths(claudeDir: string): Paths {
  return {
    dir: claudeDir,
    active: join(claudeDir, ".credentials.json"),
    state: join(claudeDir, ".credentials-switcher.json"),
    slot: (name) => join(claudeDir, `.${name}.credentials.json`),
  };
}

// --- atomic helpers ---------------------------------------------------------
export function atomicWriteBuffer(dst: string, data: Buffer | string): void {
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, data, { mode: CRED_MODE });
  chmodSync(tmp, CRED_MODE);
  renameSync(tmp, dst);
}

export function atomicCopy(src: string, dst: string): void {
  atomicWriteBuffer(dst, readFileSync(src));
}

// --- state ------------------------------------------------------------------
export function emptyCache(): AccountCache {
  return {
    email: null,
    displayName: null,
    org: null,
    uuid: null,
    lastUsageAt: null,
    inRotation: true,
    score: null,
    refreshFailures: 0,
    lastRefreshFailAt: null,
  };
}

export function readState(paths: Paths): SwitcherState {
  try {
    const raw = JSON.parse(readFileSync(paths.state, "utf8")) as unknown;
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
            // Default inRotation TRUE when absent (existing slots opt in).
            inRotation: cc.inRotation === undefined ? true : !!cc.inRotation,
            score: cc.score ?? null,
            refreshFailures: cc.refreshFailures ?? 0,
            lastRefreshFailAt: cc.lastRefreshFailAt ?? null,
          };
        }
      }
      return {
        active: typeof obj.active === "string" ? obj.active : null,
        accounts,
        lastAutoSwitchAt: typeof obj.lastAutoSwitchAt === "number" ? obj.lastAutoSwitchAt : null,
      };
    }
  } catch {
    // fall through
  }
  return { active: null, accounts: {}, lastAutoSwitchAt: null };
}

export function writeState(paths: Paths, state: SwitcherState): void {
  atomicWriteBuffer(paths.state, JSON.stringify(state, null, 2) + "\n");
}

/** Toggle inRotation for a slot and persist immediately. Returns new value. */
export function toggleRotation(paths: Paths, name: string): boolean {
  const state = readState(paths);
  const cur = state.accounts[name] ?? emptyCache();
  const next = !(cur.inRotation ?? true);
  state.accounts[name] = { ...cur, inRotation: next };
  writeState(paths, state);
  return next;
}

/** Cache usage score + timestamp for a slot. */
export function cacheUsage(paths: Paths, name: string, score: number | null, at: number): void {
  const state = readState(paths);
  const cur = state.accounts[name] ?? emptyCache();
  state.accounts[name] = { ...cur, score, lastUsageAt: at };
  writeState(paths, state);
}

export function setActive(paths: Paths, name: string | null): void {
  const state = readState(paths);
  state.active = name;
  writeState(paths, state);
}

export function setLastAutoSwitchAt(paths: Paths, at: number): void {
  const state = readState(paths);
  state.lastAutoSwitchAt = at;
  writeState(paths, state);
}

// --- the swap ---------------------------------------------------------------
export type LockApi = {
  lock: (dir: string, opts?: unknown) => Promise<() => Promise<void>>;
};

const defaultLock: LockApi = {
  lock: (dir, opts) => lockfile.lock(dir, opts as never),
};

/**
 * Switch the active account to `target`, safely:
 *  1. Take a proper-lockfile lock on the .claude dir (best-effort).
 *  2. Read the LIVE .credentials.json (Claude Code may have rotated tokens)
 *     and save THOSE bytes back to the current active's slot.
 *  3. Copy target slot -> .credentials.json (atomic, 0600).
 *  4. Update state.active. Optionally stamp lastAutoSwitchAt.
 *
 * `lockApi` is injectable for tests. Returns { savedBack: bool }.
 */
export async function performSwitchSafe(
  paths: Paths,
  target: string,
  currentActive: string | null,
  opts: { stampAutoSwitchAt?: number; lockApi?: LockApi } = {},
): Promise<{ savedBack: boolean }> {
  const lockApi = opts.lockApi ?? defaultLock;
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockApi.lock(paths.dir, {
      retries: { retries: 5, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
      stale: 10000,
    });
  } catch {
    release = null; // proceed best-effort if lock unavailable
  }

  let savedBack = false;
  try {
    // Save the LIVE active file back to the outgoing slot (capture rotation).
    if (currentActive && currentActive !== target && existsSync(paths.active)) {
      atomicCopy(paths.active, paths.slot(currentActive));
      savedBack = true;
    }
    // Bring the target in.
    atomicCopy(paths.slot(target), paths.active);
    chmodSync(paths.active, CRED_MODE);
    // Update state under the lock.
    const state = readState(paths);
    state.active = target;
    if (opts.stampAutoSwitchAt !== undefined) state.lastAutoSwitchAt = opts.stampAutoSwitchAt;
    writeState(paths, state);
  } finally {
    if (release) await release().catch(() => {});
  }
  return { savedBack };
}
