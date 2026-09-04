import express, { type Request, type Response, type Router } from "express";

import { config } from "./config.js";
import { exchangeAuthorizationCode } from "./auth.js";
import { randomId, verifyPkce } from "./crypto.js";
import { log } from "./logger.js";
import {
  getClient,
  getToken,
  registerClient,
  revokeToken,
  saveFlow,
  saveToken,
  takeFlow,
  upsertUser,
} from "./store.js";

/**
 * OAuth 2.1 authorization server, sitting in front of Zoho.
 *
 * The MCP client (Claude) talks OAuth to us; we talk OAuth to Zoho. The user
 * sees one Zoho login screen and nothing else. We never hand a Zoho token to
 * the client — it gets an opaque token of ours that maps to a stored Zoho
 * refresh token.
 *
 *   Claude  --/authorize-->  us  --redirect-->  Zoho login
 *   Zoho    --/callback--->  us  (store refresh token, mint our code)
 *   Claude  --/token----->   us  (verify PKCE, issue our access token)
 *   Claude  --/mcp------->   us  (bearer -> user -> their Zoho creds)
 */

/** The externally reachable base URL, e.g. https://x.up.railway.app */
export const publicUrl = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");

export const oauthEnabled = Boolean(publicUrl && process.env.TOKEN_ENCRYPTION_KEY);

const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-flight authorizations and issued codes live in Postgres, not memory.
 * Held in memory they were lost whenever the process restarted -- routine on
 * an ephemeral host -- stranding anyone mid-sign-in, and they broke outright
 * as soon as more than one instance was running.
 */

/** Keyed by the state we hand Zoho. Short-lived. */
interface Pending {
  clientId: string;
  clientRedirectUri: string;
  clientState?: string;
  codeChallenge: string;
}

/** Codes we issued to the MCP client, awaiting exchange at /token. */
interface IssuedCode {
  zpuid: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
}

const callbackUri = () => `${publicUrl}/callback`;

/* ------------------------------------------------------------------ *
 * Identity lookup
 * ------------------------------------------------------------------ */

/**
 * Map a zpuid to the portal user id (600...) that timelogs are stamped with.
 * Requires ZohoProjects.users.READ; returns null when the scope is absent so
 * a token issued before that scope was added still works, just without
 * per-user timesheet filtering.
 */
export async function lookupPortalUser(
  accessToken: string,
  portalId: string,
  zpuid: string,
): Promise<{ portalUserId: string; email: string; name: string } | null> {
  try {
    const res = await fetch(`${config.apiBase}/portal/${portalId}/users/`, {
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    });
    const json: any = await res.json().catch(() => ({}));

    if (json?.error) {
      log.warn(`users lookup unavailable (${json.error.code}): ${json.error.message}`);
      return null;
    }

    const users: any[] = json.users ?? [];
    // The id field names vary between portals, so try each known spelling
    // before giving up.
    const match = users.find((u) =>
      [u.zpuid, u.id, u.user_id, u.zuid].some((v) => String(v ?? "") === String(zpuid)),
    );

    if (!match) {
      // Log the shape, never the contents — this is other people's data.
      log.warn(
        `zpuid ${zpuid} not in the portal user list (${users.length} entries; ` +
          `fields: ${users[0] ? Object.keys(users[0]).join(",") : "none"})`,
      );
      return null;
    }

    return {
      portalUserId: String(match.id ?? match.user_id ?? ""),
      email: String(match.email ?? ""),
      name: String(match.name ?? match.full_name ?? ""),
    };
  } catch (err) {
    log.warn("users lookup failed", String(err));
    return null;
  }
}

/**
 * Resolve who just authorized us: their zpuid from the portal, and their
 * portal user id from the user list.
 */
async function resolveZohoIdentity(accessToken: string): Promise<{
  zpuid: string;
  portalUserId: string;
  portalId: string;
  email: string;
  name: string;
}> {
  const res = await fetch(`${config.apiBase}/portals/`, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
  });
  const json: any = await res.json().catch(() => ({}));
  const portals: any[] = json.portals ?? [];

  if (portals.length === 0) {
    throw new Error("This Zoho account has no accessible Projects portal.");
  }

  const portal =
    portals.find((p) => String(p.id_string ?? p.id) === String(config.portalId)) ?? portals[0];

  const zpuid = String(portal.login_zpuid ?? "");
  if (!zpuid) throw new Error("Zoho did not report a user id for this account.");

  // The signed-in user appears in the portal's own profile block.
  const profile = portal.profile_details ?? {};
  const owner = portal.portal_owner ?? {};
  const isOwner = String(owner.zpuid ?? "") === zpuid;
  const portalId = String(portal.id_string ?? portal.id);

  // Authoritative: the portal user list carries the 600... id for everyone.
  const looked = await lookupPortalUser(accessToken, portalId, zpuid);

  return {
    zpuid,
    portalId,
    portalUserId: looked?.portalUserId || (isOwner ? String(owner.id ?? "") : ""),
    email: looked?.email || String(isOwner ? owner.email : (profile.email ?? "")) || "",
    name:
      looked?.name || String(isOwner ? owner.first_name : (profile.name ?? "")) || "Zoho user",
  };
}

/* ------------------------------------------------------------------ *
 * Router
 * ------------------------------------------------------------------ */

export function oauthRouter(): Router {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true }));

  /* -- discovery ---------------------------------------------------- */

  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
    });
  });

  const asMetadata = (_req: Request, res: Response) => {
    res.json({
      issuer: publicUrl,
      authorization_endpoint: `${publicUrl}/authorize`,
      token_endpoint: `${publicUrl}/token`,
      registration_endpoint: `${publicUrl}/register`,
      revocation_endpoint: `${publicUrl}/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["zoho.timesheet"],
    });
  };
  router.get("/.well-known/oauth-authorization-server", asMetadata);
  // Some clients probe this path variant.
  router.get("/.well-known/openid-configuration", asMetadata);

  /* -- dynamic client registration ---------------------------------- */

  router.post("/register", express.json(), async (req, res) => {
    const redirectUris: string[] = req.body?.redirect_uris ?? [];
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({
        error: "invalid_redirect_uri",
        error_description: "redirect_uris is required.",
      });
      return;
    }

    const client = await registerClient(
      String(req.body?.client_name ?? "MCP client"),
      redirectUris,
    );
    log.info(`registered client "${client.clientName}" (${client.clientId})`);

    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  /* -- authorize: bounce the user to Zoho --------------------------- */

  router.get("/authorize", async (req, res) => {
    const clientId = String(req.query.client_id ?? "");
    const redirectUri = String(req.query.redirect_uri ?? "");
    const codeChallenge = String(req.query.code_challenge ?? "");
    const method = String(req.query.code_challenge_method ?? "");
    const state = req.query.state ? String(req.query.state) : undefined;

    const client = await getClient(clientId);
    if (!client) {
      res.status(400).send("Unknown client_id. Register the client first.");
      return;
    }
    if (!client.redirectUris.includes(redirectUri)) {
      res.status(400).send("redirect_uri does not match this client's registration.");
      return;
    }
    // PKCE is mandatory: these are public clients with no secret to prove.
    if (!codeChallenge || method !== "S256") {
      res.status(400).send("PKCE with code_challenge_method=S256 is required.");
      return;
    }

    const zohoState = randomId(24);
    await saveFlow(
      "pending",
      zohoState,
      {
        clientId,
        clientRedirectUri: redirectUri,
        clientState: state,
        codeChallenge,
      } satisfies Pending,
      Date.now() + AUTH_CODE_TTL_MS,
    );

    const zohoAuth = new URL(`${config.accountsBase}/oauth/v2/auth`);
    zohoAuth.searchParams.set("client_id", config.clientId);
    zohoAuth.searchParams.set("response_type", "code");
    zohoAuth.searchParams.set("redirect_uri", callbackUri());
    zohoAuth.searchParams.set("scope", ZOHO_SCOPES);
    // Both are required for Zoho to return a refresh token.
    zohoAuth.searchParams.set("access_type", "offline");
    zohoAuth.searchParams.set("prompt", "consent");
    zohoAuth.searchParams.set("state", zohoState);

    res.redirect(zohoAuth.toString());
  });

  /* -- callback: Zoho returns here ---------------------------------- */

  router.get("/callback", async (req, res) => {
    const zohoState = String(req.query.state ?? "");
    const zohoCode = String(req.query.code ?? "");
    // Single-use: takeFlow reads and deletes atomically.
    const flow = await takeFlow<Pending>("pending", zohoState);

    if (!flow) {
      res.status(400).send(page("Link expired", "Start the connection again from Claude."));
      return;
    }

    if (req.query.error) {
      res.status(400).send(page("Zoho declined", String(req.query.error)));
      return;
    }

    try {
      const { accessToken, refreshToken } = await exchangeAuthorizationCode(
        zohoCode,
        callbackUri(),
      );
      const identity = await resolveZohoIdentity(accessToken);
      await upsertUser({ ...identity, refreshToken });

      const code = randomId(32);
      await saveFlow(
        "code",
        code,
        {
          zpuid: identity.zpuid,
          clientId: flow.clientId,
          redirectUri: flow.clientRedirectUri,
          codeChallenge: flow.codeChallenge,
        } satisfies IssuedCode,
        Date.now() + AUTH_CODE_TTL_MS,
      );

      const back = new URL(flow.clientRedirectUri);
      back.searchParams.set("code", code);
      if (flow.clientState) back.searchParams.set("state", flow.clientState);
      res.redirect(back.toString());
    } catch (err) {
      log.error("callback failed", err instanceof Error ? err.message : String(err));
      res
        .status(500)
        .send(page("Could not connect", err instanceof Error ? err.message : String(err)));
    }
  });

  /* -- token -------------------------------------------------------- */

  router.post("/token", async (req, res) => {
    const grantType = String(req.body?.grant_type ?? "");

    // Public clients send no secret, so client_id is all we can bind to --
    // but a grant must still only be redeemable by the client it was issued
    // to, otherwise any registered client that obtains one can use it.
    const presentedClientId = String(req.body?.client_id ?? "");

    if (grantType === "refresh_token") {
      const presented = String(req.body?.refresh_token ?? "");
      const stored = await getToken(presented);
      if (!stored || stored.kind !== "refresh") {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (presentedClientId && presentedClientId !== stored.clientId) {
        res.status(400).json({
          error: "invalid_grant",
          error_description: "This refresh token was issued to a different client.",
        });
        return;
      }
      res.json(await issueAccessToken(stored.zpuid, stored.clientId, presented));
      return;
    }

    if (grantType !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const code = String(req.body?.code ?? "");
    const verifier = String(req.body?.code_verifier ?? "");

    // Single use, whatever happens next: the read deletes it, which also
    // stops two concurrent requests redeeming the same code.
    const record = await takeFlow<IssuedCode>("code", code);

    if (!record) {
      res.status(400).json({ error: "invalid_grant", error_description: "Code expired." });
      return;
    }

    if (presentedClientId && presentedClientId !== record.clientId) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "This code was issued to a different client.",
      });
      return;
    }
    if (String(req.body?.redirect_uri ?? "") !== record.redirectUri) {
      res.status(400).json({ error: "invalid_grant", error_description: "redirect_uri mismatch." });
      return;
    }
    if (!verifier || !verifyPkce(verifier, record.codeChallenge)) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE check failed." });
      return;
    }

    res.json(await issueAccessToken(record.zpuid, record.clientId));
  });

  /* -- revoke ------------------------------------------------------- */

  router.post("/revoke", async (req, res) => {
    const token = String(req.body?.token ?? "");
    if (token) await revokeToken(token);
    res.status(200).json({});
  });

  return router;
}

async function issueAccessToken(zpuid: string, clientId: string, reuseRefresh?: string) {
  const access = randomId(32);
  await saveToken({
    token: access,
    zpuid,
    clientId,
    kind: "access",
    expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
  });

  let refresh = reuseRefresh;
  if (!refresh) {
    refresh = randomId(32);
    await saveToken({ token: refresh, zpuid, clientId, kind: "refresh", expiresAt: 0 });
  }

  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh,
    scope: "zoho.timesheet",
  };
}

export const ZOHO_SCOPES = [
  "ZohoProjects.timesheets.ALL",
  "ZohoProjects.tasks.ALL",
  "ZohoProjects.projects.READ",
  "ZohoProjects.portals.READ",
  // Needed to map a zpuid to the portal user id that timelogs are stamped
  // with. Without it, per-user timesheet filtering cannot work.
  "ZohoProjects.users.READ",
  // Zoho People check-in / check-out times. Read-only, and the only People
  // scope needed: the attendance report takes an email address, so no
  // employee-record read is involved.
  "ZohoPeople.attendance.READ",
].join(",");

/** Minimal styled page for the two moments a human sees a browser tab. */
export function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
 body{font:16px/1.6 system-ui,sans-serif;margin:0;min-height:100vh;display:grid;
   place-items:center;background:#faf9f7;color:#1a1a1a}
 .card{max-width:32rem;padding:2.5rem;background:#fff;border:1px solid #e5e3df;
   border-radius:12px;text-align:center}
 h1{font-size:1.35rem;margin:0 0 .75rem}
 p{margin:0;color:#555}
 @media(prefers-color-scheme:dark){body{background:#1a1a1a;color:#eee}
   .card{background:#242424;border-color:#3a3a3a}p{color:#aaa}}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}
