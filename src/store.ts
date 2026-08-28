import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decrypt, encrypt } from "./crypto.js";
import { log } from "./logger.js";

/**
 * Persistence for the multi-user OAuth path.
 *
 * A JSON file, loaded once and rewritten atomically. At ~100 users this is
 * genuinely adequate — the whole file is a few hundred KB and writes happen
 * only on sign-in and token issue. Swap for Postgres if you outgrow a single
 * instance; the interface below is the seam.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

const STORE_PATH =
  process.env.STORE_PATH?.trim() || path.resolve(here, "..", "data", "store.json");

/** A person who has connected their Zoho account. */
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
  createdAt: string;
  updatedAt: string;
}

/** An MCP client that registered itself via dynamic client registration. */
export interface StoredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: string;
}

/** A token we issued to an MCP client, mapping back to a Zoho user. */
export interface StoredToken {
  token: string;
  zpuid: string;
  clientId: string;
  expiresAt: number;
  /** Refresh tokens never expire on their own; access tokens do. */
  kind: "access" | "refresh";
}

interface StoreShape {
  users: Record<string, StoredUser>;
  clients: Record<string, StoredClient>;
  tokens: Record<string, StoredToken>;
}

const empty: StoreShape = { users: {}, clients: {}, tokens: {} };

let data: StoreShape | null = null;

function load(): StoreShape {
  if (data) return data;
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as StoreShape;
    data = { ...empty, ...parsed };
    log.info(
      `store loaded: ${Object.keys(data.users).length} user(s), ` +
        `${Object.keys(data.clients).length} client(s)`,
    );
  } catch {
    data = structuredClone(empty);
  }
  return data;
}

/** Write via a temp file + rename so a crash cannot truncate the store. */
function persist(): void {
  const current = load();
  try {
    fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(current, null, 2), "utf8");
    fs.renameSync(tmp, STORE_PATH);
  } catch (err) {
    log.error(`could not persist store to ${STORE_PATH}`, String(err));
  }
}

/* ----------------------------- users ----------------------------- */

export function upsertUser(input: {
  zpuid: string;
  portalUserId: string;
  portalId: string;
  email: string;
  name: string;
  refreshToken: string;
}): StoredUser {
  const store = load();
  const now = new Date().toISOString();
  const existing = store.users[input.zpuid];

  const user: StoredUser = {
    zpuid: input.zpuid,
    portalUserId: input.portalUserId,
    portalId: input.portalId,
    email: input.email,
    name: input.name,
    refreshTokenEnc: encrypt(input.refreshToken),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  store.users[input.zpuid] = user;
  persist();
  log.info(`stored Zoho connection for ${input.email} (${input.zpuid})`);
  return user;
}

export function getUser(zpuid: string): StoredUser | undefined {
  return load().users[zpuid];
}

export function getUserRefreshToken(zpuid: string): string | undefined {
  const user = load().users[zpuid];
  if (!user) return undefined;
  try {
    return decrypt(user.refreshTokenEnc);
  } catch (err) {
    log.error(`could not decrypt refresh token for ${zpuid}`, String(err));
    return undefined;
  }
}

/** Fill in details discovered after sign-in, e.g. the portal user id. */
export function updateUserDetails(
  zpuid: string,
  patch: Partial<Pick<StoredUser, "portalUserId" | "email" | "name">>,
): void {
  const store = load();
  const user = store.users[zpuid];
  if (!user) return;
  let changed = false;
  for (const [k, v] of Object.entries(patch) as [keyof typeof patch, string][]) {
    if (v && user[k] !== v) {
      user[k] = v;
      changed = true;
    }
  }
  if (changed) {
    user.updatedAt = new Date().toISOString();
    persist();
    log.info(`updated stored details for ${user.email || zpuid}`);
  }
}

export function listUsers(): StoredUser[] {
  return Object.values(load().users);
}

/** Disconnect a user: drops their Zoho token and every token issued to them. */
export function deleteUser(zpuid: string): boolean {
  const store = load();
  const existed = Boolean(store.users[zpuid]);
  delete store.users[zpuid];
  for (const [tok, meta] of Object.entries(store.tokens)) {
    if (meta.zpuid === zpuid) delete store.tokens[tok];
  }
  persist();
  return existed;
}

/* ---------------------------- clients ---------------------------- */

export function registerClient(clientName: string, redirectUris: string[]): StoredClient {
  const store = load();
  const client: StoredClient = {
    clientId: `mcp_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
    clientName,
    redirectUris,
    createdAt: new Date().toISOString(),
  };
  store.clients[client.clientId] = client;
  persist();
  return client;
}

export function getClient(clientId: string): StoredClient | undefined {
  return load().clients[clientId];
}

/* ----------------------------- tokens ---------------------------- */

export function saveToken(token: StoredToken): void {
  const store = load();
  store.tokens[token.token] = token;
  persist();
}

export function getToken(token: string): StoredToken | undefined {
  const found = load().tokens[token];
  if (!found) return undefined;
  if (found.kind === "access" && found.expiresAt < Date.now()) {
    revokeToken(token);
    return undefined;
  }
  return found;
}

export function revokeToken(token: string): void {
  const store = load();
  delete store.tokens[token];
  persist();
}

/** Drop expired access tokens. Called periodically by the HTTP server. */
export function pruneExpiredTokens(): number {
  const store = load();
  const now = Date.now();
  let removed = 0;
  for (const [tok, meta] of Object.entries(store.tokens)) {
    if (meta.kind === "access" && meta.expiresAt < now) {
      delete store.tokens[tok];
      removed++;
    }
  }
  if (removed) persist();
  return removed;
}

export const storePath = STORE_PATH;
