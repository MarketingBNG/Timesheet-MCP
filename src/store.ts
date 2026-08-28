import pg from "pg";
import { decrypt, encrypt } from "./crypto.js";
import { log } from "./logger.js";

/**
 * Persistence for the multi-user OAuth path, on Postgres.
 *
 * Postgres rather than a local file because the target host has no persistent
 * disk — a file store would be wiped on every restart and all users would have
 * to reconnect. This also removes the single-writer constraint, so the service
 * can run more than one instance.
 *
 * Only the OAuth path touches this. stdio and single-account HTTP never call
 * in here, so DATABASE_URL is required only when OAuth is enabled.
 */

const CONNECTION_STRING = process.env.DATABASE_URL?.trim();

let pool: pg.Pool | null = null;

function db(): pg.Pool {
  if (pool) return pool;

  if (!CONNECTION_STRING) {
    throw new Error(
      "DATABASE_URL is required when OAuth is enabled. Create a free Postgres " +
        "database (Neon, Supabase) and set its connection string.",
    );
  }

  pool = new pg.Pool({
    connectionString: CONNECTION_STRING,
    // Managed Postgres providers terminate TLS at their proxy with a cert
    // chain node-postgres will not verify by default.
    ssl: /sslmode=(require|verify)/.test(CONNECTION_STRING)
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", (err) => log.error("postgres pool error", err.message));
  return pool;
}

/** Create the schema if it is not already there. Safe to run on every boot. */
export async function initStore(): Promise<void> {
  await db().query(`
    CREATE TABLE IF NOT EXISTS users (
      zpuid             TEXT PRIMARY KEY,
      portal_user_id    TEXT NOT NULL DEFAULT '',
      portal_id         TEXT NOT NULL,
      email             TEXT NOT NULL DEFAULT '',
      name              TEXT NOT NULL DEFAULT '',
      refresh_token_enc TEXT NOT NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS oauth_clients (
      client_id     TEXT PRIMARY KEY,
      client_name   TEXT NOT NULL,
      redirect_uris JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS tokens (
      token      TEXT PRIMARY KEY,
      zpuid      TEXT NOT NULL,
      client_id  TEXT NOT NULL,
      kind       TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS tokens_zpuid_idx ON tokens (zpuid);
  `);

  const { rows } = await db().query<{ count: string }>("SELECT count(*) FROM users");
  log.info(`store ready (postgres): ${rows[0].count} connected user(s)`);
}

export async function closeStore(): Promise<void> {
  await pool?.end();
  pool = null;
}

/* ------------------------------- types ------------------------------- */

export interface StoredUser {
  /** Zoho zpuid — the task-owner id space. Primary key. */
  zpuid: string;
  /** Portal user id (600...) — the timelog-owner id space. */
  portalUserId: string;
  portalId: string;
  email: string;
  name: string;
  /** AES-GCM encrypted Zoho refresh token. */
  refreshTokenEnc: string;
}

export interface StoredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface StoredToken {
  token: string;
  zpuid: string;
  clientId: string;
  expiresAt: number;
  /** Refresh tokens never expire on their own; access tokens do. */
  kind: "access" | "refresh";
}

/* ------------------------------- users ------------------------------- */

function toUser(row: any): StoredUser {
  return {
    zpuid: row.zpuid,
    portalUserId: row.portal_user_id,
    portalId: row.portal_id,
    email: row.email,
    name: row.name,
    refreshTokenEnc: row.refresh_token_enc,
  };
}

export async function upsertUser(input: {
  zpuid: string;
  portalUserId: string;
  portalId: string;
  email: string;
  name: string;
  refreshToken: string;
}): Promise<StoredUser> {
  const { rows } = await db().query(
    `INSERT INTO users (zpuid, portal_user_id, portal_id, email, name, refresh_token_enc)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (zpuid) DO UPDATE SET
       portal_user_id    = EXCLUDED.portal_user_id,
       portal_id         = EXCLUDED.portal_id,
       email             = EXCLUDED.email,
       name              = EXCLUDED.name,
       refresh_token_enc = EXCLUDED.refresh_token_enc,
       updated_at        = now()
     RETURNING *`,
    [
      input.zpuid,
      input.portalUserId,
      input.portalId,
      input.email,
      input.name,
      encrypt(input.refreshToken),
    ],
  );
  log.info(`stored Zoho connection for ${input.email || input.zpuid}`);
  return toUser(rows[0]);
}

export async function getUser(zpuid: string): Promise<StoredUser | undefined> {
  const { rows } = await db().query("SELECT * FROM users WHERE zpuid = $1", [zpuid]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

export async function getUserRefreshToken(zpuid: string): Promise<string | undefined> {
  const user = await getUser(zpuid);
  if (!user) return undefined;
  try {
    return decrypt(user.refreshTokenEnc);
  } catch (err) {
    log.error(`could not decrypt refresh token for ${zpuid}`, String(err));
    return undefined;
  }
}

/** Fill in details discovered after sign-in, e.g. the portal user id. */
export async function updateUserDetails(
  zpuid: string,
  patch: { portalUserId?: string; email?: string; name?: string },
): Promise<void> {
  await db().query(
    `UPDATE users SET
       portal_user_id = COALESCE(NULLIF($2, ''), portal_user_id),
       email          = COALESCE(NULLIF($3, ''), email),
       name           = COALESCE(NULLIF($4, ''), name),
       updated_at     = now()
     WHERE zpuid = $1`,
    [zpuid, patch.portalUserId ?? "", patch.email ?? "", patch.name ?? ""],
  );
}

export async function listUsers(): Promise<StoredUser[]> {
  const { rows } = await db().query("SELECT * FROM users ORDER BY created_at");
  return rows.map(toUser);
}

/** Disconnect a user: drops their Zoho token and every token issued to them. */
export async function deleteUser(zpuid: string): Promise<boolean> {
  await db().query("DELETE FROM tokens WHERE zpuid = $1", [zpuid]);
  const { rowCount } = await db().query("DELETE FROM users WHERE zpuid = $1", [zpuid]);
  return (rowCount ?? 0) > 0;
}

/* ------------------------------ clients ------------------------------ */

export async function registerClient(
  clientName: string,
  redirectUris: string[],
): Promise<StoredClient> {
  const clientId = `mcp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  await db().query(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES ($1, $2, $3)",
    [clientId, clientName, JSON.stringify(redirectUris)],
  );
  return { clientId, clientName, redirectUris };
}

export async function getClient(clientId: string): Promise<StoredClient | undefined> {
  const { rows } = await db().query("SELECT * FROM oauth_clients WHERE client_id = $1", [
    clientId,
  ]);
  if (!rows[0]) return undefined;
  return {
    clientId: rows[0].client_id,
    clientName: rows[0].client_name,
    redirectUris: rows[0].redirect_uris,
  };
}

/* ------------------------------- tokens ------------------------------ */

export async function saveToken(token: StoredToken): Promise<void> {
  await db().query(
    `INSERT INTO tokens (token, zpuid, client_id, kind, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (token) DO NOTHING`,
    [token.token, token.zpuid, token.clientId, token.kind, token.expiresAt],
  );
}

export async function getToken(token: string): Promise<StoredToken | undefined> {
  const { rows } = await db().query("SELECT * FROM tokens WHERE token = $1", [token]);
  const row = rows[0];
  if (!row) return undefined;

  const found: StoredToken = {
    token: row.token,
    zpuid: row.zpuid,
    clientId: row.client_id,
    kind: row.kind,
    expiresAt: Number(row.expires_at),
  };

  if (found.kind === "access" && found.expiresAt < Date.now()) {
    await revokeToken(token);
    return undefined;
  }
  return found;
}

export async function revokeToken(token: string): Promise<void> {
  await db().query("DELETE FROM tokens WHERE token = $1", [token]);
}

/** Drop expired access tokens. Called periodically by the HTTP server. */
export async function pruneExpiredTokens(): Promise<number> {
  const { rowCount } = await db().query(
    "DELETE FROM tokens WHERE kind = 'access' AND expires_at < $1",
    [Date.now()],
  );
  return rowCount ?? 0;
}
