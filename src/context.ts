import { AsyncLocalStorage } from "node:async_hooks";
import { config } from "./config.js";

/**
 * Who the current request is acting as.
 *
 * In stdio mode there is no context and everything falls back to the single
 * service account in .env — the original single-user behaviour, unchanged.
 * In OAuth mode the HTTP layer establishes a context per request, and every
 * Zoho call below transparently uses that person's credentials and ids.
 */
export interface UserContext {
  /** login_zpuid from /portals/ — our primary key for the user. */
  zpuid: string;
  /**
   * The Zoho user id (ZUID, a 600... number on this data centre). It is the id
   * Zoho stamps on timelogs as owner_id, the `id` on task owner records, and
   * what person_responsible takes. Empty until resolved.
   */
  portalUserId: string;
  portalId: string;
  refreshToken: string;
  email: string;
  name: string;
  /** Where portalUserId came from: login_id | timelog_write | users_endpoint | legacy | "" */
  portalUserIdSource?: string;
  /** Projects this connector has written to for this user (loaded by the HTTP layer). */
  rememberedProjects?: Array<{ project_id: string; project_name: string }>;
  /**
   * Mutable, per-request. Anything a Zoho call reveals about the caller while
   * serving this request lands here and is persisted by the HTTP layer from
   * this same object — never from module state, which would let one user's
   * discovery be filed under another's account.
   */
  discovered?: Discovered;
}

export interface Discovered {
  /** Learned during this request; empty if nothing new. */
  ownerId?: string;
  ownerIdSource?: "login_id" | "timelog_write";
  /** A write came back stamped with a different user id than we believe the caller has. */
  ownerIdConflict?: { believed: string; observed: string };
  /** project_id -> project_name written to during this request. */
  projects: Map<string, string>;
}

const storage = new AsyncLocalStorage<UserContext>();

export function runWithUser<T>(ctx: UserContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentUser(): UserContext | undefined {
  return storage.getStore();
}

/**
 * Service-account identity learned at runtime (stdio / single-account mode),
 * for when ZOHO_TIMELOG_OWNER_ID is not configured. One process, one user, so
 * module state is correct here — and only here.
 */
let serviceAccountUserId = "";
const serviceDiscovered: Discovered = { projects: new Map() };

export function setServiceAccountUserId(id: string): void {
  serviceAccountUserId = id;
}

/** Test hook: forget the service-account identity learned at runtime. */
export function resetForTests(): void {
  serviceAccountUserId = "";
  serviceDiscovered.projects.clear();
  delete serviceDiscovered.ownerId;
  delete serviceDiscovered.ownerIdSource;
  delete serviceDiscovered.ownerIdConflict;
}

/** The per-request discovery slot, or the service account's in stdio mode. */
export function discoveries(): Discovered {
  const user = storage.getStore();
  if (!user) return serviceDiscovered;
  if (!user.discovered) user.discovered = { projects: new Map() };
  return user.discovered;
}

/**
 * The credentials and ids the current call should use — the signed-in user's
 * when there is one, the service account's otherwise.
 */
export function effective(): {
  portalId: string;
  refreshToken: string;
  /** login zpuid — our user key. Do NOT compare it with task owner zpuids: they differ. */
  userId: string;
  /** Zoho user id (ZUID, 600...) — matches timelog owner_id and task owner id. Empty = unknown. */
  timelogOwnerId: string;
  email: string;
  label: string;
} {
  const user = storage.getStore();
  if (user) {
    return {
      portalId: user.portalId,
      refreshToken: user.refreshToken,
      userId: user.zpuid,
      timelogOwnerId: user.portalUserId,
      email: user.email,
      label: user.email || user.zpuid,
    };
  }
  return {
    portalId: config.portalId,
    refreshToken: config.refreshToken,
    userId: config.userId,
    timelogOwnerId: config.timelogOwnerId || serviceAccountUserId,
    email: "",
    label: "service account",
  };
}

/**
 * Record a resolved caller id on the current context so the rest of this
 * request sees it, and flag it for persistence by the HTTP layer.
 */
export function adoptCallerUserId(id: string, source: "login_id" | "timelog_write"): void {
  const user = storage.getStore();
  if (user) {
    user.portalUserId = id;
    user.portalUserIdSource = source;
  } else {
    serviceAccountUserId = id;
  }
  const d = discoveries();
  d.ownerId = id;
  d.ownerIdSource = source;
}
