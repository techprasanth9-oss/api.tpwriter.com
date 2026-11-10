import { Hono } from "hono";
import { vValidator } from "@hono/valibot-validator";
import { deleteCookie, setCookie } from "hono/cookie";
import { env } from "../env";
import { User } from "../models/user";
import { hashPassword, verifyPassword } from "../auth/password";
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
} from "../auth/jwt";
import { requireAuth, type AuthContext } from "../auth/middleware";
import { rateLimit } from "../middleware/rateLimit";
import { LoginInput, SignupInput } from "../schemas/auth";

export const auth = new Hono<AuthContext>();

const loginLimit = rateLimit({ name: "login", windowMs: 15 * 60_000, max: 10 });
const signupLimit = rateLimit({ name: "signup", windowMs: 60 * 60_000, max: 5 });

auth.post("/signup", signupLimit, vValidator("json", SignupInput), async (c) => {
  const { email, password, displayName } = c.req.valid("json");

  const existing = await User.exists({ email });
  if (existing) return c.json({ error: "email_taken" }, 409);

  const passwordHash = await hashPassword(password);
  const created = await User.create({
    email,
    passwordHash,
    displayName: displayName ?? null,
  }).catch((err: { code?: number }) => {
    // Lost a race with a concurrent signup for the same email.
    if (err.code === 11000) return null;
    throw err;
  });
  if (!created) return c.json({ error: "email_taken" }, 409);

  setSessionCookieOn(
    c,
    signSession({ userId: created._id.toString(), email: created.email }),
  );
  return c.json(toPublic(created), 201);
});

auth.post("/login", loginLimit, vValidator("json", LoginInput), async (c) => {
  const { email, password } = c.req.valid("json");

  const user = await User.findOne({ email });
  if (!user) return c.json({ error: "invalid_credentials" }, 401);

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) return c.json({ error: "invalid_credentials" }, 401);

  setSessionCookieOn(
    c,
    signSession({ userId: user._id.toString(), email: user.email }),
  );
  return c.json(toPublic(user));
});

auth.post("/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.body(null, 204);
});

auth.get("/me", requireAuth, async (c) => {
  const session = c.get("session");
  const user = await User.findById(session.userId);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  return c.json(toPublic(user));
});

function toPublic(u: {
  _id: { toString(): string };
  email: string;
  displayName: string | null;
  createdAt: Date;
}) {
  return {
    id: u._id.toString(),
    email: u.email,
    displayName: u.displayName,
    createdAt: u.createdAt.toISOString(),
  };
}

function setSessionCookieOn(
  c: Parameters<typeof setCookie>[0],
  token: string,
) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: env.isProd,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}
