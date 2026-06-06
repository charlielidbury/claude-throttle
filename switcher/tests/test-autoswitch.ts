// File-mechanics tests for rotation toggle + auto-switch, against TEMP-DIR
// copies. NEVER touches ~/.claude. No network, no live refresh. The lock is
// mocked so we can assert it is taken/released around the swap.
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makePaths,
  readState,
  writeState,
  toggleRotation,
  cacheUsage,
  performSwitchSafe,
  emptyCache,
  type LockApi,
} from "../src/credstore";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function cred(tag: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: `ACCESS_${tag}`,
      refreshToken: `REFRESH_${tag}`,
      expiresAt: 9_999_999_999_999,
      scopes: ["user:profile"],
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_5x",
    },
  });
}

function setupDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoswitch-test-"));
  // Two slots; active currently == robbie.
  writeFileSync(join(dir, ".robbie.credentials.json"), cred("robbie_slot"), { mode: 0o600 });
  writeFileSync(join(dir, ".charlie.credentials.json"), cred("charlie"), { mode: 0o600 });
  // The LIVE active file: simulate Claude Code having rotated robbie's token
  // since it was last saved to the slot (so live != slot).
  writeFileSync(join(dir, ".credentials.json"), cred("robbie_ROTATED"), { mode: 0o600 });
  // State file with active=robbie, both in rotation.
  const paths = makePaths(dir);
  writeState(paths, {
    active: "robbie",
    accounts: {
      robbie: { ...emptyCache(), inRotation: true },
      charlie: { ...emptyCache(), inRotation: true },
    },
    lastAutoSwitchAt: null,
  });
  return dir;
}

function mockLock(): { api: LockApi; calls: string[] } {
  const calls: string[] = [];
  const api: LockApi = {
    lock: async (dir) => {
      calls.push(`lock:${dir}`);
      return async () => {
        calls.push("release");
      };
    },
  };
  return { api, calls };
}

async function main() {
  // ---- rotation toggle persistence ----
  console.log("\n[toggle] inRotation flips and persists (atomic 0600)");
  {
    const dir = setupDir();
    const paths = makePaths(dir);
    check("default inRotation true", readState(paths).accounts.charlie.inRotation === true);

    const v1 = toggleRotation(paths, "charlie");
    check("toggle returns false", v1 === false);
    check("persisted false", readState(paths).accounts.charlie.inRotation === false);
    const mode = statSync(paths.state).mode & 0o777;
    check("state file mode 0600", mode === 0o600, mode.toString(8));

    const v2 = toggleRotation(paths, "charlie");
    check("toggle back to true", v2 === true);
    check("persisted true", readState(paths).accounts.charlie.inRotation === true);

    // toggling does not disturb other accounts / active
    check("robbie untouched", readState(paths).accounts.robbie.inRotation === true);
    check("active unchanged", readState(paths).active === "robbie");
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- cacheUsage ----
  console.log("\n[cacheUsage] score + lastUsageAt persist");
  {
    const dir = setupDir();
    const paths = makePaths(dir);
    cacheUsage(paths, "charlie", 11, 123456);
    const st = readState(paths);
    check("score cached", st.accounts.charlie.score === 11);
    check("lastUsageAt cached", st.accounts.charlie.lastUsageAt === 123456);
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- the swap: live-read save-back, lock taken, target installed ----
  console.log("\n[swap] reads LIVE active, saves it to outgoing slot, under lock");
  {
    const dir = setupDir();
    const paths = makePaths(dir);
    const { api, calls } = mockLock();

    const liveBefore = readFileSync(paths.active); // robbie_ROTATED
    const robbieSlotBefore = readFileSync(paths.slot("robbie")); // robbie_slot (stale)
    check("precondition: live != slot (rotation simulated)", !liveBefore.equals(robbieSlotBefore));

    const NOW = 555;
    const res = await performSwitchSafe(paths, "charlie", "robbie", {
      stampAutoSwitchAt: NOW,
      lockApi: api,
    });

    check("savedBack=true", res.savedBack === true);
    // outgoing slot now holds the LIVE (rotated) bytes, not its old stale copy
    const robbieSlotAfter = readFileSync(paths.slot("robbie"));
    check("outgoing robbie slot = LIVE active bytes", robbieSlotAfter.equals(liveBefore));
    check("outgoing robbie slot changed from stale", !robbieSlotAfter.equals(robbieSlotBefore));

    // active file now == charlie slot
    const activeAfter = readFileSync(paths.active);
    const charlieSlot = readFileSync(paths.slot("charlie"));
    check("active == charlie slot", activeAfter.equals(charlieSlot));
    check("active mode 0600", (statSync(paths.active).mode & 0o777) === 0o600);

    // state updated
    const st = readState(paths);
    check("state.active = charlie", st.active === "charlie");
    check("state.lastAutoSwitchAt stamped", st.lastAutoSwitchAt === NOW);

    // lock was taken around the swap and released
    check("lock taken on the dir", calls[0] === `lock:${dir}`, calls.join(","));
    check("lock released", calls.includes("release"));
    check("lock released last (after writes)", calls[calls.length - 1] === "release");

    rmSync(dir, { recursive: true, force: true });
  }

  // ---- swap is a no-op-ish when target == active (no save-back) ----
  console.log("\n[swap] target already active: no save-back, still installs");
  {
    const dir = setupDir();
    const paths = makePaths(dir);
    const { api } = mockLock();
    const res = await performSwitchSafe(paths, "robbie", "robbie", { lockApi: api });
    check("no save-back when target == active", res.savedBack === false);
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();
