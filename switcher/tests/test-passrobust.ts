// Robustness tests for the usage-refresh pass: 429-doesn't-clobber,
// serialized (non-bursting) requests, and refresh backoff. Pure mocked I/O —
// no network, no temp creds, never touches ~/.claude.
import {
  runUsagePass,
  refreshBackoffMs,
  isRefreshBackedOff,
  REFRESH_BACKOFF_BASE_MS,
  REFRESH_BACKOFF_MAX_MS,
  type PassAccount,
} from "../src/balance";

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
const isError = (u: U) => u === "error";
const noSleep = { isError, gapMs: 0, sleep: async () => {} };
const NOW = 1_000_000_000_000;
const GOOD: U = { fiveHour: { use: 12 }, sevenDay: { use: 34 } };

function acct(over: Partial<PassAccount<U>>): PassAccount<U> {
  return {
    name: "x",
    isActive: false,
    inRotation: true,
    expiresAt: NOW + 3600_000,
    lastUsageAt: NOW,
    usage: GOOD, // prior GOOD value by default
    refreshFailures: 0,
    lastRefreshFailAt: null,
    ...over,
  };
}

async function main() {
  // ---- FIX 1: a 429 ("error") MUST NOT clobber the prior good value ----
  console.log("\n[clobber] 429 mid-pass leaves prior value intact");
  {
    // robbie returns good; charlie 429s; brit returns good. charlie must keep
    // its prior GOOD value (fetched:false), not get overwritten with error.
    const accounts: PassAccount<U>[] = [
      acct({ name: "robbie", isActive: true, usage: GOOD }),
      acct({ name: "charlie", usage: GOOD }),
      acct({ name: "brit", usage: GOOD }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => ({ expiresAt: NOW + 3600_000 }),
      fetchUsage: async (name) =>
        name === "charlie" ? "error" : { fiveHour: { use: 1 }, sevenDay: { use: 2 } },
      ...noSleep,
    });
    const by = Object.fromEntries(results.map((r) => [r.name, r]));
    check("charlie not fetched (429 treated as failure)", by.charlie.fetched === false);
    check("charlie keeps prior GOOD value (not clobbered)", by.charlie.usage === GOOD);
    check("robbie fetched fresh", by.robbie.fetched === true && by.robbie.usage !== GOOD);
    check("brit fetched fresh", by.brit.fetched === true && by.brit.usage !== GOOD);
  }

  // a transient error must never produce fetched:true with an error usage
  console.log("\n[clobber] every-account 429 -> all keep prior, none clobbered");
  {
    const accounts: PassAccount<U>[] = [
      acct({ name: "a", usage: GOOD }),
      acct({ name: "b", usage: GOOD }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => ({ expiresAt: NOW + 3600_000 }),
      fetchUsage: async () => "error",
      ...noSleep,
    });
    check("none fetched", results.every((r) => !r.fetched));
    check("all keep prior GOOD", results.every((r) => r.usage === GOOD));
  }

  // ---- FIX 2: requests are SERIAL (concurrency 1), not a Promise.all burst ----
  console.log("\n[serial] requests issued one-at-a-time (max concurrency 1)");
  {
    let inFlight = 0;
    let maxConcurrent = 0;
    const order: string[] = [];
    const accounts: PassAccount<U>[] = [
      acct({ name: "a", expiresAt: NOW - 1 }), // expired -> refresh THEN usage
      acct({ name: "b" }),
      acct({ name: "c" }),
    ];
    const track = async <T>(label: string, fn: () => T): Promise<T> => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      order.push(label);
      // simulate async work; if anything ran concurrently, inFlight would be >1
      await Promise.resolve();
      const v = fn();
      inFlight--;
      return v;
    };
    await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: (name) => track(`refresh:${name}`, () => ({ expiresAt: NOW + 3600_000 })),
      fetchUsage: (name) => track(`usage:${name}`, () => GOOD),
      ...noSleep,
    });
    check("max concurrency was 1 (no burst)", maxConcurrent === 1, `max=${maxConcurrent}`);
    // a's refresh must come before a's usage, before b/c usages (no interleaved burst)
    check("refresh precedes its own usage", order.indexOf("refresh:a") < order.indexOf("usage:a"), order.join(","));
    check(
      "expired account's refresh happens before other accounts' usage GETs",
      order.indexOf("refresh:a") < order.indexOf("usage:b") &&
        order.indexOf("refresh:a") < order.indexOf("usage:c"),
      order.join(","),
    );
  }

  // gap sleeps happen between requests (count >= requests-1)
  console.log("\n[serial] inter-request gap applied between calls");
  {
    let sleeps = 0;
    const accounts: PassAccount<U>[] = [acct({ name: "a" }), acct({ name: "b" }), acct({ name: "c" })];
    await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => ({ expiresAt: NOW + 3600_000 }),
      fetchUsage: async () => GOOD,
      isError,
      gapMs: 250,
      sleep: async () => {
        sleeps++;
      },
    });
    // 3 usage GETs (all valid, no refresh) -> 2 gaps between them
    check("gap applied between the 3 usage requests (2 sleeps)", sleeps === 2, `sleeps=${sleeps}`);
  }

  // ---- FIX 3: refresh backoff after repeated failures ----
  console.log("\n[backoff] refreshBackoffMs is exponential and capped");
  {
    check("0 failures -> 0ms", refreshBackoffMs(0) === 0);
    check("1 failure -> base", refreshBackoffMs(1) === REFRESH_BACKOFF_BASE_MS);
    check("2 failures -> 2x base", refreshBackoffMs(2) === REFRESH_BACKOFF_BASE_MS * 2);
    check("3 failures -> 4x base", refreshBackoffMs(3) === REFRESH_BACKOFF_BASE_MS * 4);
    check("huge failure count caps at max", refreshBackoffMs(50) === REFRESH_BACKOFF_MAX_MS);
  }

  console.log("\n[backoff] isRefreshBackedOff windows");
  {
    check("no failures -> not backed off", isRefreshBackedOff(NOW, 0, NOW + 1000) === false);
    check(
      "within window -> backed off",
      isRefreshBackedOff(NOW, 1, NOW + REFRESH_BACKOFF_BASE_MS - 1) === true,
    );
    check(
      "after window -> not backed off",
      isRefreshBackedOff(NOW, 1, NOW + REFRESH_BACKOFF_BASE_MS + 1) === false,
    );
    check("null lastFailAt -> not backed off", isRefreshBackedOff(null, 3, NOW) === false);
  }

  console.log("\n[backoff] pass SKIPS refresh while backed off (no /token hammering)");
  {
    let refreshCalls = 0;
    // expired account that recently failed its refresh -> within backoff window
    const accounts: PassAccount<U>[] = [
      acct({
        name: "dead",
        isActive: false,
        expiresAt: NOW - 1, // expired -> would normally refresh
        refreshFailures: 2,
        lastRefreshFailAt: NOW - 1000, // 1s ago; backoff is minutes
      }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => {
        refreshCalls++;
        return { expiresAt: NOW + 3600_000 };
      },
      fetchUsage: async () => GOOD,
      ...noSleep,
    });
    check("refresh NOT attempted while backed off", refreshCalls === 0);
    check("result flags refreshSkippedBackoff", results[0].refreshSkippedBackoff === true);
    check("doomed usage GET skipped (still expired)", results[0].fetched === false);
  }

  console.log("\n[backoff] pass DOES refresh once the backoff window elapses");
  {
    let refreshCalls = 0;
    const accounts: PassAccount<U>[] = [
      acct({
        name: "recovering",
        isActive: false,
        expiresAt: NOW - 1,
        refreshFailures: 1,
        lastRefreshFailAt: NOW - (REFRESH_BACKOFF_BASE_MS + 1000), // window elapsed
      }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => {
        refreshCalls++;
        return { expiresAt: NOW + 3600_000 };
      },
      fetchUsage: async () => GOOD,
      ...noSleep,
    });
    check("refresh attempted after backoff elapsed", refreshCalls === 1);
    check("refreshed flag set", results[0].refreshed === true);
    check("usage then fetched", results[0].fetched === true);
  }

  console.log("\n[backoff] a failing refresh reports refreshFailed (so caller can increment)");
  {
    const accounts: PassAccount<U>[] = [
      acct({ name: "fail", isActive: false, expiresAt: NOW - 1, refreshFailures: 0, lastRefreshFailAt: null }),
    ];
    const results = await runUsagePass(accounts, NOW, true, {
      refreshIfExpired: async () => {
        throw new Error("invalid_grant");
      },
      fetchUsage: async () => GOOD,
      ...noSleep,
    });
    check("refreshFailed reported on throw", results[0].refreshFailed === true);
    check("not marked refreshed", results[0].refreshed === false);
    check("doomed usage skipped (still expired)", results[0].fetched === false);
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();
