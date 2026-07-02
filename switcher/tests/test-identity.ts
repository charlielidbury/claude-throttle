// Tests for cache self-correction by account identity (uuid + token
// fingerprint). All against TEMP dirs / synthetic OAuth — never ~/.claude,
// never any network or token refresh.
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identityFingerprint,
  reconcileCachedIdentity,
  mergeProfileIntoCache,
  loadAll,
  type OAuth,
} from "../src/core";
import { makePaths, writeState, readState, emptyCache } from "../src/credstore";

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

function oauth(refreshToken: string, over: Partial<OAuth> = {}): OAuth {
  return {
    accessToken: "access-" + refreshToken,
    refreshToken,
    expiresAt: Date.now() + 3600_000,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_5x",
    ...over,
  };
}

function writeCred(path: string, o: OAuth): void {
  writeFileSync(path, JSON.stringify({ claudeAiOauth: o }), { mode: 0o600 });
}

function main() {
  // --- mergeProfileIntoCache: uuid change clears old identity --------------
  console.log("\n[mergeProfileIntoCache] uuid change overwrites stale identity");
  {
    const cur = {
      ...emptyCache(),
      email: "old@example.com",
      displayName: "Old",
      uuid: "uuid-OLD",
      identityFingerprint: "stale",
    };
    const o = oauth("tokenX");
    const merged = mergeProfileIntoCache(
      cur,
      { email: "new@example.com", displayName: "New", uuid: "uuid-NEW" },
      o,
    );
    check("email overwritten to new", merged.email === "new@example.com");
    check("displayName overwritten", merged.displayName === "New");
    check("uuid overwritten", merged.uuid === "uuid-NEW");
    check("does NOT keep old email", merged.email !== "old@example.com");
    check("fingerprint restamped to current token", merged.identityFingerprint === identityFingerprint(o));
  }

  // --- mergeProfileIntoCache: same uuid keeps identity --------------------
  console.log("\n[mergeProfileIntoCache] same uuid keeps cached identity");
  {
    const cur = {
      ...emptyCache(),
      email: "me@example.com",
      displayName: "Me",
      uuid: "uuid-SAME",
      identityFingerprint: "old-fp",
    };
    const o = oauth("rotated-token");
    const merged = mergeProfileIntoCache(
      cur,
      { email: "me@example.com", displayName: "Me", uuid: "uuid-SAME" },
      o,
    );
    check("email preserved", merged.email === "me@example.com");
    check("uuid preserved", merged.uuid === "uuid-SAME");
    check("fingerprint restamped (rotation tracked)", merged.identityFingerprint === identityFingerprint(o));
  }

  // --- reconcileCachedIdentity: rotation (same uuid) keeps email ----------
  console.log("\n[reconcileCachedIdentity] rotated token alone does not invalidate when fingerprint kept current");
  {
    const o1 = oauth("token-v1");
    // Identity resolved against token-v1.
    const cached = {
      ...emptyCache(),
      email: "user@example.com",
      uuid: "uuid-1",
      identityFingerprint: identityFingerprint(o1),
    };
    // Same token -> trusted.
    const same = reconcileCachedIdentity(cached, o1);
    check("same token: email kept", same.email === "user@example.com");

    // A rotation that ALSO restamped the fingerprint (normal refresh path):
    const o2 = oauth("token-v2");
    const afterRefresh = { ...cached, identityFingerprint: identityFingerprint(o2) };
    const r = reconcileCachedIdentity(afterRefresh, o2);
    check("rotated+restamped: email kept", r.email === "user@example.com");
  }

  // --- reconcileCachedIdentity: different account clears email ------------
  console.log("\n[reconcileCachedIdentity] fingerprint mismatch (different account) clears identity");
  {
    const oOld = oauth("token-accountA");
    const cached = {
      ...emptyCache(),
      email: "a@example.com",
      displayName: "A",
      uuid: "uuid-A",
      identityFingerprint: identityFingerprint(oOld),
    };
    // Slot now holds a DIFFERENT account's token (fingerprint won't match).
    const oNew = oauth("token-accountB");
    const r = reconcileCachedIdentity(cached, oNew);
    check("stale email cleared", r.email === null);
    check("stale displayName cleared", r.displayName === null);
    check("stale uuid cleared", r.uuid === null);
    check("fingerprint restamped to new token", r.identityFingerprint === identityFingerprint(oNew));
  }

  // --- reconcileCachedIdentity: legacy entry (no fingerprint) stamps -------
  console.log("\n[reconcileCachedIdentity] legacy entry without fingerprint keeps identity, stamps fp");
  {
    const o = oauth("token-legacy");
    const cached = {
      ...emptyCache(),
      email: "legacy@example.com",
      uuid: "uuid-legacy",
      identityFingerprint: null,
    };
    const r = reconcileCachedIdentity(cached, o);
    check("legacy email kept (no prior fp to contradict)", r.email === "legacy@example.com");
    check("legacy fingerprint stamped", r.identityFingerprint === identityFingerprint(o));
  }

  // --- loadAll: slot file swapped to a different account clears the label --
  console.log("\n[loadAll] slot file swapped to a different account clears the stale label");
  {
    const dir = mkdtempSync(join(tmpdir(), "identity-test-"));
    const p = makePaths(dir);

    // brit slot initially holds account A (token-A); state cached its email.
    const accountA = oauth("token-A");
    writeCred(p.slot("brit"), accountA);
    writeCred(p.active, accountA); // active == brit
    writeState(p, {
      active: "brit",
      accounts: {
        brit: {
          ...emptyCache(),
          email: "accountA@example.com",
          displayName: "Account A",
          uuid: "uuid-A",
          identityFingerprint: identityFingerprint(accountA),
        },
      },
      lastAutoSwitchAt: null,
    });

    // Sanity: load reads the cached label while the token still matches.
    let loaded = loadAll(p);
    const britBefore = loaded.slots.find((s) => s.name === "brit")!;
    check("before swap: cached email shown", britBefore.cache.email === "accountA@example.com");

    // Now a re-login drops account B's token into the brit slot (different acct).
    const accountB = oauth("token-B");
    writeCred(p.slot("brit"), accountB);
    writeCred(p.active, accountB); // active still byte-matches brit slot

    loaded = loadAll(p);
    const britAfter = loaded.slots.find((s) => s.name === "brit")!;
    check("after swap: stale email cleared (no wrong label)", britAfter.cache.email === null);
    check("after swap: stale uuid cleared", (britAfter.cache.uuid ?? null) === null);
    // Persisted to the state file too.
    const persisted = readState(p).accounts.brit;
    check("after swap: state file email cleared", persisted.email === null);
    check("after swap: state fingerprint = new token", persisted.identityFingerprint === identityFingerprint(accountB));

    rmSync(dir, { recursive: true, force: true });
  }

  // --- loadAll: in-place rotation keeps label when fingerprint restamped ---
  console.log("\n[loadAll] same account with restamped fingerprint keeps the label");
  {
    const dir = mkdtempSync(join(tmpdir(), "identity-test2-"));
    const p = makePaths(dir);
    const v1 = oauth("acctC-v1");
    writeCred(p.slot("charlie"), v1);
    writeCred(p.active, v1);
    writeState(p, {
      active: "charlie",
      accounts: {
        charlie: {
          ...emptyCache(),
          email: "c@example.com",
          uuid: "uuid-C",
          identityFingerprint: identityFingerprint(v1),
        },
      },
      lastAutoSwitchAt: null,
    });
    // Simulate a normal refresh: token rotates AND we restamp the fingerprint
    // (as the refresh path does) before the next load.
    const v2 = oauth("acctC-v2");
    writeCred(p.slot("charlie"), v2);
    writeCred(p.active, v2);
    const st = readState(p);
    st.accounts.charlie.identityFingerprint = identityFingerprint(v2);
    writeState(p, st);

    const loaded = loadAll(p);
    const c = loaded.slots.find((s) => s.name === "charlie")!;
    check("rotation w/ restamp: email kept", c.cache.email === "c@example.com");
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main();
