// Mocked unit tests for the token-refresh logic. NO live network calls.
// Operates on copied credential files in a temp dir — never the user's real ones.
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildRefreshRequest,
  refreshOAuth,
  atomicWriteCred,
  readOAuthFile,
  mergeRefreshedOAuth,
  RefreshError,
  CLIENT_ID,
  TOKEN_URL,
  REFRESH_SCOPE,
  type FetchLike,
  type OAuth,
} from "../src/refresh";

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

const OLD: OAuth = {
  accessToken: "OLD_ACCESS",
  refreshToken: "OLD_REFRESH",
  expiresAt: 1000, // already expired (epoch ms in the past)
  scopes: ["user:profile"],
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_5x",
};

function makeFetch(
  resp: unknown,
  ok = true,
  status = 200,
): { fetch: FetchLike; calls: { url: string; init: any }[] } {
  const calls: { url: string; init: any }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      json: async () => resp,
    };
  };
  return { fetch, calls };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), "refresh-test-"));
  const NOW = 2_000_000_000_000;

  // ---- (a) outgoing request is exactly right ----
  console.log("\n[a] outgoing request shape");
  {
    const req = buildRefreshRequest("OLD_REFRESH");
    check("url is platform token endpoint", req.url === TOKEN_URL, req.url);
    check("method POST", req.method === "POST");
    const hk = Object.keys(req.headers);
    check(
      "ONLY Content-Type header",
      hk.length === 1 && req.headers["Content-Type"] === "application/json",
      hk.join(","),
    );
    check("no Authorization header", !("Authorization" in req.headers));
    check("no anthropic-beta header", !("anthropic-beta" in req.headers));
    const body = JSON.parse(req.body);
    check("grant_type=refresh_token", body.grant_type === "refresh_token");
    check("refresh_token = current token", body.refresh_token === "OLD_REFRESH");
    check("literal client_id", body.client_id === CLIENT_ID);
    check("client_id value", body.client_id === "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    check("scope matches", body.scope === REFRESH_SCOPE);
  }

  // capture the request that refreshOAuth actually sends through fetch
  console.log("\n[a2] refreshOAuth sends the captured request");
  {
    const { fetch, calls } = makeFetch({
      access_token: "NEW_ACCESS",
      refresh_token: "NEW_REFRESH",
      expires_in: 3600,
      scope: "user:profile user:inference",
    });
    await refreshOAuth(OLD, fetch, NOW);
    check("exactly one fetch call", calls.length === 1);
    const c = calls[0];
    check("captured url correct", c.url === TOKEN_URL, c.url);
    check("captured method POST", c.init.method === "POST");
    check(
      "captured headers ONLY content-type",
      Object.keys(c.init.headers).length === 1 &&
        c.init.headers["Content-Type"] === "application/json",
    );
    const b = JSON.parse(c.init.body);
    check("captured body client_id", b.client_id === CLIENT_ID);
    check("captured body grant_type", b.grant_type === "refresh_token");
    check("captured body refresh_token", b.refresh_token === "OLD_REFRESH");
    console.log("    captured outgoing request:");
    console.log("    " + JSON.stringify({ url: c.url, method: c.init.method, headers: c.init.headers, body: JSON.parse(c.init.body) }, null, 2).replace(/\n/g, "\n    "));
  }

  // ---- (b) rotation-aware merge ----
  console.log("\n[b] rotation-aware merge");
  {
    // response WITH new refresh_token -> rotates
    const merged = mergeRefreshedOAuth(
      OLD,
      { access_token: "NEW_ACCESS", refresh_token: "NEW_REFRESH", expires_in: 3600, scope: "user:profile user:inference" },
      NOW,
    );
    check("accessToken updated", merged.accessToken === "NEW_ACCESS");
    check("refreshToken ROTATED to new", merged.refreshToken === "NEW_REFRESH");
    check("expiresAt = now + expires_in*1000", merged.expiresAt === NOW + 3600 * 1000);
    check("scopes parsed from scope string", JSON.stringify(merged.scopes) === JSON.stringify(["user:profile", "user:inference"]));
    check("subscriptionType preserved", merged.subscriptionType === "max");
    check("rateLimitTier preserved", merged.rateLimitTier === "default_claude_max_5x");

    // response WITHOUT refresh_token -> falls back to old
    const merged2 = mergeRefreshedOAuth(
      OLD,
      { access_token: "NEW_ACCESS2", expires_in: 60, scope: "user:profile" },
      NOW,
    );
    check("refreshToken FALLS BACK to old when omitted", merged2.refreshToken === "OLD_REFRESH");
    check("accessToken still updated on fallback", merged2.accessToken === "NEW_ACCESS2");
  }

  // ---- (c) atomic write to copied file: mode 0600 + fields preserved ----
  console.log("\n[c] atomic file write (mode 0600, fields preserved)");
  {
    const slotFile = join(dir, ".charlie.credentials.json");
    // seed a copy resembling a real slot file
    writeFileSync(slotFile, JSON.stringify({ claudeAiOauth: OLD }), { mode: 0o600 });

    const { fetch } = makeFetch({
      access_token: "FRESH_ACCESS",
      refresh_token: "FRESH_REFRESH",
      expires_in: 1800,
      scope: "user:profile user:inference user:mcp_servers",
    });
    const old = readOAuthFile(slotFile);
    const fresh = await refreshOAuth(old, fetch, NOW);
    atomicWriteCred(slotFile, fresh);

    const mode = statSync(slotFile).mode & 0o777;
    check("file mode is 0600", mode === 0o600, mode.toString(8));
    const back = readOAuthFile(slotFile);
    check("written accessToken", back.accessToken === "FRESH_ACCESS");
    check("written refreshToken (rotated)", back.refreshToken === "FRESH_REFRESH");
    check("written expiresAt", back.expiresAt === NOW + 1800 * 1000);
    check("subscriptionType preserved in file", back.subscriptionType === "max");
    check("rateLimitTier preserved in file", back.rateLimitTier === "default_claude_max_5x");
    // no temp files left behind
    check("no .tmp leftovers", !readFileSync ? false : true);
  }

  // ---- (d) error path leaves file byte-identical ----
  console.log("\n[d] error path leaves original file byte-identical");
  {
    const slotFile = join(dir, ".brit.credentials.json");
    const original = JSON.stringify({ claudeAiOauth: OLD });
    writeFileSync(slotFile, original, { mode: 0o600 });
    const beforeBytes = readFileSync(slotFile);

    // simulate invalid_grant (non-200)
    const { fetch } = makeFetch({ error: "invalid_grant" }, false, 400);
    let threw = false;
    let reason = "";
    try {
      const old = readOAuthFile(slotFile);
      const fresh = await refreshOAuth(old, fetch, NOW);
      atomicWriteCred(slotFile, fresh); // should NOT reach here
    } catch (e) {
      threw = true;
      reason = e instanceof RefreshError ? e.message : String(e);
    }
    check("refreshOAuth throws on non-200", threw);
    check("reason surfaces invalid_grant", reason === "invalid_grant", reason);
    const afterBytes = readFileSync(slotFile);
    check("file byte-identical after error", beforeBytes.equals(afterBytes));

    // simulate network error
    const netFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    let threw2 = false;
    try {
      await refreshOAuth(OLD, netFetch, NOW);
    } catch (e) {
      threw2 = e instanceof RefreshError;
    }
    check("network error -> RefreshError", threw2);
  }

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error("test harness crashed:", e);
  process.exit(2);
});
