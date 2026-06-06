// Tests for the unified usage-refresh pass (the `u` toggle's per-tick work)
// and its caching into the state file. Mocked I/O, TEMP-DIR state, NO live
// refresh, never touches the real ~/.claude.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runUsagePass,
  isDue,
  needsRefresh,
  usageScore,
  USAGE_REFRESH_MS,
  ACTIVE_POLL_MS,
  INACTIVE_POLL_MS,
  type PassAccount,
} from "../src/balance";
import {
  makePaths,
  writeState,
  readState,
  cacheUsage,
  emptyCache,
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

type U = { fiveHour: { use: number }; sevenDay: { use: number } } | "error";

const NOW = 1_000_000_000_000;

function acct(over: Partial<PassAccount<U>>): PassAccount<U> {
  return {
    name: "x",
    isActive: false,
    inRotation: true,
    expiresAt: NOW + 3600_000, // valid by default
    lastUsageAt: null,
    usage: "error",
    ...over,
  };
}

async function main() {
  check("USAGE_REFRESH_MS default 30000", USAGE_REFRESH_MS === 30_000);

  // ---- isDue --------------------------------------------------------------
  console.log("\n[isDue] forceAll vs cadence gating");
  {
    const a = acct({ name: "a", isActive: false, inRotation: true, lastUsageAt: NOW });
    check("forceAll => due even if just fetched", isDue(a, NOW, true) === true);
    check("not forced + fresh inactive => not due", isDue(a, NOW, false) === false);
    check(
      "not forced + stale inactive => due",
      isDue({ ...a, lastUsageAt: NOW - INACTIVE_POLL_MS - 1 }, NOW, false) === true,
    );
    const active = acct({ isActive: true, lastUsageAt: NOW - ACTIVE_POLL_MS - 1 });
    check("not forced + stale active => due", isDue(active, NOW, false) === true);
    const outRot = acct({ isActive: false, inRotation: false, lastUsageAt: 0 });
    check("not forced + out-of-rotation inactive => not due", isDue(outRot, NOW, false) === false);
    check("forceAll fetches out-of-rotation too", isDue(outRot, NOW, true) === true);
  }

  // ---- needsRefresh -------------------------------------------------------
  console.log("\n[needsRefresh] only expired/near-expiry, never the active acct");
  {
    check("valid inactive => no refresh", needsRefresh(acct({ expiresAt: NOW + 3600_000 }), NOW) === false);
    check("expired inactive => refresh", needsRefresh(acct({ expiresAt: NOW - 1 }), NOW) === true);
    check("near-expiry inactive => refresh", needsRefresh(acct({ expiresAt: NOW + 30_000 }), NOW) === true);
    check("unknown expiry => refresh", needsRefresh(acct({ expiresAt: 0 }), NOW) === true);
    check(
      "active expired => still NO refresh (Claude Code keeps it live)",
      needsRefresh(acct({ isActive: true, expiresAt: NOW - 1 }), NOW) === false,
    );
  }

  // ---- runUsagePass: forceAll fetches everyone; refresh only for expired ----
  console.log("\n[runUsagePass] forceAll fetches ALL; refresh ONLY for expired token");
  {
    const refreshCalls: string[] = [];
    const fetchCalls: string[] = [];
    const accounts: PassAccount<U>[] = [
      acct({ name: "robbie", isActive: true, expiresAt: NOW + 3600_000, lastUsageAt: NOW }), // active, valid, just fetched
      acct({ name: "charlie", isActive: false, expiresAt: NOW + 3600_000, lastUsageAt: NOW }), // VALID inactive
      acct({ name: "brit", isActive: false, expiresAt: NOW - 10_000, lastUsageAt: NOW }), // EXPIRED inactive
    ];
    const results = await runUsagePass(accounts, NOW, /*forceAll*/ true, {
      refreshIfExpired: async (name) => {
        refreshCalls.push(name);
        // brit gets a fresh token valid for an hour
        return { expiresAt: NOW + 3600_000 };
      },
      fetchUsage: async (name) => {
        fetchCalls.push(name);
        if (name === "robbie") return { fiveHour: { use: 9 }, sevenDay: { use: 9 } };
        if (name === "charlie") return { fiveHour: { use: 0 }, sevenDay: { use: 84 } };
        return { fiveHour: { use: 1 }, sevenDay: { use: 2 } }; // brit, after refresh
      },
    });

    check("all 3 accounts fetched (forceAll, despite fresh lastUsageAt)", fetchCalls.length === 3, fetchCalls.join(","));
    check("fetched robbie", fetchCalls.includes("robbie"));
    check("fetched charlie (valid token, no refresh)", fetchCalls.includes("charlie"));
    check("fetched brit", fetchCalls.includes("brit"));

    // The key assertion: refresh endpoint called ONLY for the expired account.
    check("refresh called exactly once", refreshCalls.length === 1, refreshCalls.join(","));
    check("refresh called for brit (expired) only", refreshCalls[0] === "brit");
    check("refresh NOT called for charlie (valid)", !refreshCalls.includes("charlie"));
    check("refresh NOT called for robbie (active)", !refreshCalls.includes("robbie"));

    const byName = Object.fromEntries(results.map((r) => [r.name, r]));
    check("charlie fetched without refresh", byName.charlie.fetched && !byName.charlie.refreshed);
    check("brit refreshed then fetched", byName.brit.refreshed && byName.brit.fetched);
    check("scores: charlie max(0,84)=84", usageScore(byName.charlie.usage) === 84);
    check("scores: robbie max(9,9)=9", usageScore(byName.robbie.usage) === 9);
  }

  // ---- second tick: token now valid => NO further refresh ----
  console.log("\n[runUsagePass] subsequent tick with now-valid token does NOT re-refresh");
  {
    const refreshCalls: string[] = [];
    const accounts: PassAccount<U>[] = [
      acct({ name: "brit", isActive: false, expiresAt: NOW + 3500_000, lastUsageAt: NOW }), // valid now
    ];
    const results = await runUsagePass(accounts, NOW + USAGE_REFRESH_MS, true, {
      refreshIfExpired: async (name) => {
        refreshCalls.push(name);
        return { expiresAt: NOW + 3600_000 };
      },
      fetchUsage: async () => ({ fiveHour: { use: 3 }, sevenDay: { use: 4 } }),
    });
    check("no refresh on second tick (token still valid)", refreshCalls.length === 0, refreshCalls.join(","));
    check("usage still fetched on second tick", results[0].fetched === true);
  }

  // ---- failure leaves prior value ----
  console.log("\n[runUsagePass] fetch failure leaves prior usage value");
  {
    const prior: U = { fiveHour: { use: 50 }, sevenDay: { use: 50 } };
    const accounts: PassAccount<U>[] = [
      acct({ name: "charlie", expiresAt: NOW + 3600_000, lastUsageAt: NOW, usage: prior }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => null,
      fetchUsage: async () => {
        throw new Error("network down");
      },
    });
    check("failed fetch -> usage unchanged (prior kept)", results[0].usage === prior);
    check("failed fetch -> fetched=false", results[0].fetched === false);
  }

  // ---- expired token whose refresh also fails => skip doomed fetch ----
  console.log("\n[runUsagePass] expired + refresh fails => no usage fetch attempted");
  {
    const fetchCalls: string[] = [];
    const accounts: PassAccount<U>[] = [
      acct({ name: "brit", isActive: false, expiresAt: NOW - 1, lastUsageAt: 0 }),
    ];
    await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => null, // refresh produced nothing
      fetchUsage: async (n) => {
        fetchCalls.push(n);
        return "error";
      },
    });
    check("doomed fetch skipped when still expired after failed refresh", fetchCalls.length === 0);
  }

  // ---- state caching round-trip (temp dir) ----
  console.log("\n[state] pass results cache score + lastUsageAt to temp state file");
  {
    const dir = mkdtempSync(join(tmpdir(), "usagepass-test-"));
    const paths = makePaths(dir);
    writeState(paths, {
      active: "robbie",
      accounts: {
        robbie: { ...emptyCache() },
        charlie: { ...emptyCache() },
      },
      lastAutoSwitchAt: null,
    });

    // Simulate the App caching a pass result.
    cacheUsage(paths, "charlie", 84, NOW + 5);
    const st = readState(paths);
    check("charlie score cached", st.accounts.charlie.score === 84);
    check("charlie lastUsageAt cached", st.accounts.charlie.lastUsageAt === NOW + 5);
    check("robbie untouched (score null)", (st.accounts.robbie.score ?? null) === null);
    check("active unchanged", st.active === "robbie");
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();
