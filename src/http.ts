#!/usr/bin/env node
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { config } from "./config.js";
import { runWithUser, type UserContext } from "./context.js";
import { safeEqual } from "./crypto.js";
import { log } from "./logger.js";
import { lookupPortalUser, oauthEnabled, oauthRouter, publicUrl } from "./oauth.js";
import { createServer } from "./server.js";
import {
  getToken,
  getUser,
  getUserRefreshToken,
  initStore,
  listUserProjects,
  pruneExpiredFlows,
  pruneExpiredTokens,
  rememberUserProjects,
  setPortalUserId,
  updateUserDetails,
} from "./store.js";
import { REMEMBERED_PROJECT_LIMIT } from "./timesheet.js";
import { getLoginUserId, getPortalMeta } from "./zoho.js";
import { getAccessToken } from "./auth.js";

/**
 * HTTP entry point — the deployable form of the server.
 *
 * Two modes, chosen by configuration:
 *
 *  - OAuth mode (PUBLIC_URL + TOKEN_ENCRYPTION_KEY set): each person connects
 *    their own Zoho account and every call runs as them. This is the mode to
 *    deploy for a team.
 *  - Single-account mode: falls back to the service account in .env, guarded
 *    by a shared secret. Fine for one person or for local testing.
 *
 * Requests are stateless — a fresh McpServer and transport per POST, torn down
 * when the response closes — so this scales horizontally and survives a
 * restart mid-conversation.
 */

const PORT = Number(process.env.PORT ?? 3000);

/** Shared secret used only in single-account mode. */
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim();

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "8mb" }));

app.get("/healthz", (_req: Request, res: Response) => {
  res.json({
    ok: true,
    mode: oauthEnabled ? "oauth" : "single-account",
    portal: config.portalId,
    dc: config.domain,
  });
});

if (oauthEnabled) {
  app.use(oauthRouter());
  setInterval(() => {
    void pruneExpiredTokens();
    void pruneExpiredFlows();
  }, 15 * 60 * 1000).unref();
}

/**
 * Resolve the caller. Returns a context in OAuth mode, `null` when the request
 * is authorised but has no specific user (single-account mode), or throws the
 * 401 itself.
 */
async function authenticate(req: Request, res: Response): Promise<UserContext | null | false> {
  if (!oauthEnabled) {
    if (AUTH_TOKEN) {
      const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
      if (!bearer || !safeEqual(bearer, AUTH_TOKEN)) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return false;
      }
    }
    return null; // service account
  }

  const bearer = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const record = bearer ? await getToken(bearer) : undefined;

  if (!record || record.kind !== "access") {
    // Point the client at discovery so it knows how to authenticate.
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized — connect your Zoho account." },
      id: null,
    });
    return false;
  }

  const user = await getUser(record.zpuid);
  const refreshToken = await getUserRefreshToken(record.zpuid);

  if (!user || !refreshToken) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Your Zoho connection was removed. Reconnect." },
      id: null,
    });
    return false;
  }

  return {
    zpuid: user.zpuid,
    portalUserId: user.portalUserId,
    portalUserIdSource: user.portalUserIdSource,
    portalId: user.portalId,
    refreshToken,
    email: user.email,
    name: user.name,
  };
}

/**
 * How long to wait before retrying an identity lookup that failed, so a user
 * whose /portals/ call errors does not cost an extra Zoho call per request.
 */
const RESOLVE_RETRY_MS = 30 * 60 * 1000;
const resolveAttempts = new Map<string, number>();

/** Users whose stored id has been checked against /portals/ login_id in this process. */
const verifiedThisProcess = new Set<string>();

/** Keep the retry map from growing without bound over a long uptime. */
function noteAttempt(zpuid: string): void {
  const now = Date.now();
  if (resolveAttempts.size > 500) {
    for (const [k, t] of resolveAttempts) {
      if (now - t > RESOLVE_RETRY_MS) resolveAttempts.delete(k);
    }
  }
  resolveAttempts.set(zpuid, now);
}

/**
 * Make sure the context carries the caller's real Zoho user id.
 *
 * The id comes from /portals/ login_id, which is bound to the caller's own
 * token. It fills in users who connected before this existed, and — once per
 * process per user — checks an id that is already stored. An earlier version
 * could learn an id off a task Zoho had assigned to a colleague; a stored id
 * that disagrees with login_id is exactly that mistake, and is corrected here
 * with an error in the log rather than left to misfile time.
 *
 * Best effort: a failure here must never block the request.
 */
async function establishIdentity(ctx: UserContext): Promise<UserContext> {
  if (ctx.portalUserId && verifiedThisProcess.has(ctx.zpuid)) return ctx;

  const lastTried = resolveAttempts.get(ctx.zpuid) ?? 0;
  if (Date.now() - lastTried < RESOLVE_RETRY_MS) return ctx;

  const who = ctx.email || ctx.zpuid;
  try {
    const loginId = await runWithUser(ctx, () => getLoginUserId());
    if (!loginId) {
      noteAttempt(ctx.zpuid);
      log.warn(
        `/portals/ reported no login_id for ${who}; ` +
          (ctx.portalUserId
            ? `keeping stored user id ${ctx.portalUserId} (${ctx.portalUserIdSource || "unverified"})`
            : `their timesheet cannot be read until it does. Retrying in 30 minutes.`),
      );
      return ctx;
    }

    verifiedThisProcess.add(ctx.zpuid);
    resolveAttempts.delete(ctx.zpuid);

    if (ctx.portalUserId !== loginId) {
      if (ctx.portalUserId) {
        log.error(
          `stored user id ${ctx.portalUserId} (source: ${ctx.portalUserIdSource || "unknown"}) ` +
            `for ${who} does not match /portals/ login_id ${loginId}; correcting it`,
        );
      } else {
        log.info(`resolved user id ${loginId} for ${who} from /portals/ login_id`);
      }
      await setPortalUserId(ctx.zpuid, ctx.portalId, loginId, "login_id");
      ctx = { ...ctx, portalUserId: loginId, portalUserIdSource: "login_id" };
    } else if (ctx.portalUserIdSource !== "login_id") {
      await setPortalUserId(ctx.zpuid, ctx.portalId, loginId, "login_id");
      ctx = { ...ctx, portalUserIdSource: "login_id" };
    }

    // Email and name are only cosmetic here, but attendance is looked up by
    // email, so fill them in when the portal user list is readable.
    if (!ctx.email || !ctx.name) {
      const accessToken = await runWithUser(ctx, () => getAccessToken());
      const looked = await lookupPortalUser(accessToken, ctx.portalId, loginId);
      if (looked) {
        await updateUserDetails(ctx.zpuid, { email: looked.email, name: looked.name });
        ctx = { ...ctx, email: ctx.email || looked.email, name: ctx.name || looked.name };
      }
    }
    return ctx;
  } catch (err) {
    noteAttempt(ctx.zpuid);
    log.warn(`identity check failed for ${who}`, String(err));
    return ctx;
  }
}

/**
 * After a request, persist what it revealed about the caller — from the SAME
 * context object the request ran in, so nothing can be filed under another
 * user who happened to finish at the same time.
 */
async function persistDiscoveries(who: UserContext, storedIdBefore: string): Promise<void> {
  const d = who.discovered;
  if (!d) return;

  if (d.ownerId && d.ownerIdSource && d.ownerId !== storedIdBefore) {
    try {
      await setPortalUserId(who.zpuid, who.portalId, d.ownerId, d.ownerIdSource);
      // Only an id that came from the caller's own token (/portals/ login_id)
      // is trusted enough to stop re-checking. One read off a Zoho write
      // response stays open to correction on the next request.
      if (d.ownerIdSource === "login_id") verifiedThisProcess.add(who.zpuid);
      log.info(`persisted user id ${d.ownerId} (${d.ownerIdSource}) for ${who.email || who.zpuid}`);
    } catch (err) {
      log.warn("could not persist the caller's user id", String(err));
    }
  }

  if (d.projects.size > 0) {
    // Every project written to, not only the ones we did not already know:
    // the upsert also bumps last_written_at, and the read side keeps the most
    // recently written. Skipping known ones froze their timestamp, so the
    // project someone logs to every day would eventually age out of the window
    // and its hours would stop being found.
    const written = [...d.projects].map(([project_id, project_name]) => ({
      project_id,
      project_name,
    }));
    try {
      await rememberUserProjects(who.zpuid, who.portalId, written);
    } catch (err) {
      log.warn("could not persist written projects", String(err));
    }
  }
}

app.post("/mcp", async (req: Request, res: Response) => {
  let who = await authenticate(req, res);
  if (who === false) return;

  if (who) {
    who = await establishIdentity(who);
    try {
      who.rememberedProjects = await listUserProjects(
        who.zpuid,
        who.portalId,
        REMEMBERED_PROJECT_LIMIT,
      );
    } catch (err) {
      log.warn("could not load remembered projects", String(err));
    }
  }

  const server = createServer();
  const transport = new StreamableHTTPServerTransport({
    // Stateless: no session ids, no server-side session table.
    sessionIdGenerator: undefined,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  const handle = async () => {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };

  try {
    const storedIdBefore = who?.portalUserId ?? "";
    await (who ? runWithUser(who, handle) : handle());
    if (who) await persistDiscoveries(who, storedIdBefore);
  } catch (err) {
    log.error("request failed", err instanceof Error ? err.stack : String(err));
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no stream to resume and no session to delete.
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed — this server is stateless." },
    id: null,
  });
};
app.get("/mcp", notAllowed);
app.delete("/mcp", notAllowed);

async function boot(): Promise<void> {
  // Fail fast if the database is unreachable — in OAuth mode nothing works
  // without it, and a clear error at boot beats a 500 on first sign-in.
  if (oauthEnabled) await initStore();

  app.listen(PORT, () => {
    log.info(
      `zoho-timesheet HTTP server on :${PORT} — ${oauthEnabled ? "OAuth" : "single-account"} mode`,
    );
    if (oauthEnabled) {
      log.info(`public URL: ${publicUrl}`);
      log.info(`register this redirect URI on the Zoho app: ${publicUrl}/callback`);
      if (!config.portalId) {
        log.warn(
          "ZOHO_PORTAL_ID is not set: a user who belongs to several Zoho portals is bound " +
            "to whichever Zoho lists first. Set it to pin the company portal.",
        );
      }
    } else {
      log.warn(
        "OAuth is off (set PUBLIC_URL and TOKEN_ENCRYPTION_KEY to enable). " +
          "All calls will use the single service account.",
      );
      if (!AUTH_TOKEN) {
        log.warn("MCP_AUTH_TOKEN is not set — /mcp is unauthenticated. Do not deploy like this.");
      }
      getPortalMeta().catch(() => {});
    }
  });
}

boot().catch((err) => {
  log.error("failed to start", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  log.error("unhandled rejection", String(reason));
});
