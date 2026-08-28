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
  pruneExpiredTokens,
  updateUserDetails,
} from "./store.js";
import { getPortalMeta } from "./zoho.js";
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
  setInterval(() => void pruneExpiredTokens(), 15 * 60 * 1000).unref();
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
    portalId: user.portalId,
    refreshToken,
    email: user.email,
    name: user.name,
  };
}

/**
 * Users who connected before ZohoProjects.users.READ was in the scope list
 * have no portal user id, so their timesheet cannot be filtered to just them.
 * Fill it in on first use rather than making them reconnect. Best effort — a
 * failure here must never block the request.
 */
async function backfillPortalUserId(ctx: UserContext): Promise<UserContext> {
  if (ctx.portalUserId) return ctx;

  try {
    const accessToken = await runWithUser(ctx, () => getAccessToken());
    const looked = await lookupPortalUser(accessToken, ctx.portalId, ctx.zpuid);
    if (!looked?.portalUserId) return ctx;

    await updateUserDetails(ctx.zpuid, {
      portalUserId: looked.portalUserId,
      email: looked.email,
      name: looked.name,
    });
    log.info(`backfilled portal user id for ${looked.email || ctx.zpuid}`);
    return { ...ctx, portalUserId: looked.portalUserId, email: looked.email || ctx.email };
  } catch (err) {
    log.warn("portal user id backfill failed", String(err));
    return ctx;
  }
}

app.post("/mcp", async (req: Request, res: Response) => {
  let who = await authenticate(req, res);
  if (who === false) return;
  if (who) who = await backfillPortalUserId(who);

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
    await (who ? runWithUser(who, handle) : handle());
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
