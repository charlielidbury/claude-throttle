// Token refresh logic, isolated so it can be unit-tested with an injected
// `fetch` and a temp credentials file (no live calls to platform.claude.com).
import { readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const REFRESH_SCOPE =
  "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const CRED_MODE = 0o600;

export type OAuth = {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
};

export type CredFile = { claudeAiOauth: OAuth };

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
};

// Allow injecting fetch for tests.
export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** Build the exact outgoing request for a refresh. */
export function buildRefreshRequest(refreshToken: string): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    url: TOKEN_URL,
    method: "POST",
    // ONLY Content-Type — no anthropic-beta, no Authorization.
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      scope: REFRESH_SCOPE,
    }),
  };
}

/**
 * Rotation-aware merge: produce a new OAuth from the old one + token response.
 * Keeps subscriptionType/rateLimitTier; falls back to old refreshToken if the
 * response omits a new one.
 */
export function mergeRefreshedOAuth(
  old: OAuth,
  resp: TokenResponse,
  now: number = Date.now(),
): OAuth {
  return {
    accessToken: resp.access_token,
    refreshToken: resp.refresh_token ?? old.refreshToken,
    expiresAt: now + resp.expires_in * 1000,
    scopes: resp.scope ? resp.scope.split(" ") : old.scopes,
    subscriptionType: old.subscriptionType,
    rateLimitTier: old.rateLimitTier,
  };
}

/** Atomic write of a credentials file (temp + rename, mode 0600). */
export function atomicWriteCred(path: string, oauth: OAuth): void {
  const payload: CredFile = { claudeAiOauth: oauth };
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  const json = JSON.stringify(payload);
  writeFileSync(tmp, json, { mode: CRED_MODE });
  chmodSync(tmp, CRED_MODE);
  renameSync(tmp, path);
}

export function readOAuthFile(path: string): OAuth {
  const data = JSON.parse(readFileSync(path, "utf8")) as CredFile;
  return data.claudeAiOauth;
}

export class RefreshError extends Error {}

/**
 * Perform a refresh against the token endpoint and return the merged OAuth.
 * Does NOT write any file — caller decides where (active file +/- slot).
 * Throws RefreshError on any non-200 / network failure (file left untouched).
 */
export async function refreshOAuth(
  old: OAuth,
  fetchImpl: FetchLike,
  now: number = Date.now(),
): Promise<OAuth> {
  const req = buildRefreshRequest(old.refreshToken);
  let res;
  try {
    res = await fetchImpl(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
    });
  } catch (e) {
    throw new RefreshError(`network error: ${(e as Error).message}`);
  }
  if (!res.ok) {
    let reason = `http ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body && typeof body.error === "string") reason = body.error;
    } catch {
      // keep http status reason
    }
    throw new RefreshError(reason);
  }
  const resp = (await res.json()) as TokenResponse;
  if (!resp || typeof resp.access_token !== "string") {
    throw new RefreshError("malformed token response");
  }
  return mergeRefreshedOAuth(old, resp, now);
}
