import { config } from "./config.js";
import { effective } from "./context.js";
import { ZohoError } from "./errors.js";
import { log } from "./logger.js";

/**
 * Zoho access tokens, cached per refresh token.
 *
 * Keying on the refresh token rather than a single module-level slot is what
 * lets one process serve many users: each person's access token is cached and
 * refreshed independently, and a single-flight latch per key means N
 * concurrent 401s cause one refresh, not N.
 */

interface Token {
  value: string;
  /** epoch ms */
  expiresAt: number;
}

const cache = new Map<string, Token>();
const inFlight = new Map<string, Promise<Token>>();

/** Refresh a little early so a token cannot expire mid-request. */
const EARLY_REFRESH_MS = 120_000;

export async function getAccessToken(): Promise<string> {
  const { refreshToken } = effective();
  const cached = cache.get(refreshToken);
  if (cached && Date.now() < cached.expiresAt - EARLY_REFRESH_MS) {
    return cached.value;
  }
  return (await refresh(refreshToken)).value;
}

/** Force a refresh — called once after a 401 to recover from a stale token. */
export async function invalidateAndRefresh(): Promise<string> {
  const { refreshToken } = effective();
  cache.delete(refreshToken);
  return (await refresh(refreshToken)).value;
}

/** Drop a user's cached access token, e.g. when they disconnect. */
export function forgetToken(refreshToken: string): void {
  cache.delete(refreshToken);
}

function refresh(refreshToken: string): Promise<Token> {
  const existing = inFlight.get(refreshToken);
  if (existing) return existing;

  const pending = (async () => {
    const url = `${config.accountsBase}/oauth/v2/token`;
    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    });

    log.debug("refreshing access token");
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new ZohoError(
        `Token refresh returned a non-JSON response (HTTP ${res.status}).`,
        res.status,
        undefined,
        "This usually means ZOHO_DOMAIN points at the wrong data centre.",
      );
    }

    // Zoho returns HTTP 200 with an `error` field on failure.
    if (!res.ok || json.error) {
      const code = json.error ?? `HTTP ${res.status}`;
      const hint =
        code === "invalid_client"
          ? "ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET are wrong, or belong to a different data centre than ZOHO_DOMAIN."
          : code === "invalid_code" || code === "invalid_grant"
            ? "The refresh token is invalid or has been revoked. The user needs to reconnect their Zoho account."
            : undefined;
      throw new ZohoError(`Could not refresh the Zoho access token: ${code}`, res.status, code, hint);
    }

    const expiresInSec = Number(json.expires_in ?? 3600);
    const token: Token = {
      value: json.access_token,
      expiresAt: Date.now() + expiresInSec * 1000,
    };
    cache.set(refreshToken, token);
    log.debug(`access token refreshed, valid for ${expiresInSec}s`);
    return token;
  })();

  inFlight.set(refreshToken, pending);

  // Clear the latch whether it resolved or rejected, so a failure can be retried.
  return pending.finally(() => {
    inFlight.delete(refreshToken);
  });
}

/**
 * Exchange an authorization code for tokens. Used by the OAuth callback when a
 * user connects their own Zoho account.
 */
export async function exchangeAuthorizationCode(
  code: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${config.accountsBase}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri,
      code,
    }),
  });

  const json: any = await res.json().catch(() => ({}));

  if (!res.ok || json.error || !json.access_token) {
    throw new ZohoError(
      `Zoho rejected the authorization code: ${json.error ?? `HTTP ${res.status}`}`,
      res.status,
      json.error,
      "The code may have expired, or the redirect URI does not match the one registered " +
        "on the Zoho application.",
    );
  }

  if (!json.refresh_token) {
    throw new ZohoError(
      "Zoho returned no refresh token.",
      res.status,
      undefined,
      "The authorization request must include access_type=offline and prompt=consent.",
    );
  }

  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}
