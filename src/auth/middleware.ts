import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, verifySession, type SessionPayload } from "./jwt";

export interface AuthContext {
  Variables: {
    session: SessionPayload;
  };
}

/**
 * Attach the verified session payload to the Hono context on every
 * authenticated request. Returns 401 if the session cookie is missing or
 * invalid — mount this on every route that reads / mutates user data.
 */
export const requireAuth: MiddlewareHandler<AuthContext> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const session = verifySession(token);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  c.set("session", session);
  await next();
};

export function getSession(c: Context<AuthContext>): SessionPayload {
  return c.get("session");
}
