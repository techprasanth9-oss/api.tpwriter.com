import jwt from "jsonwebtoken";
import { env } from "../env";

const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface SessionPayload {
  userId: string;
  email: string;
}

export function signSession(payload: SessionPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: TTL_SECONDS });
}

export function verifySession(token: string): SessionPayload | null {
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as SessionPayload & {
      iat: number;
      exp: number;
    };
    return { userId: decoded.userId, email: decoded.email };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "tp_session";
export const SESSION_TTL_SECONDS = TTL_SECONDS;
