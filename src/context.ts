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
  zpuid: string;
  portalUserId: string;
  portalId: string;
  refreshToken: string;
  email: string;
  name: string;
}

const storage = new AsyncLocalStorage<UserContext>();

export function runWithUser<T>(ctx: UserContext, fn: () => Promise<T>): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentUser(): UserContext | undefined {
  return storage.getStore();
}

/**
 * The credentials and ids the current call should use — the signed-in user's
 * when there is one, the service account's otherwise.
 */
export function effective(): {
  portalId: string;
  refreshToken: string;
  /** zpuid — matches task owners. */
  userId: string;
  /** 600... id — matches timelog owners. Empty means "do not filter". */
  timelogOwnerId: string;
  label: string;
} {
  const user = storage.getStore();
  if (user) {
    return {
      portalId: user.portalId,
      refreshToken: user.refreshToken,
      userId: user.zpuid,
      timelogOwnerId: user.portalUserId,
      label: user.email || user.zpuid,
    };
  }
  return {
    portalId: config.portalId,
    refreshToken: config.refreshToken,
    userId: config.userId,
    timelogOwnerId: config.timelogOwnerId,
    label: "service account",
  };
}
