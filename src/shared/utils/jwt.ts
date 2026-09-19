import { randomUUID } from "node:crypto";
import type { Role } from "@prisma/client";
import jwt, { type SignOptions } from "jsonwebtoken";
import { env } from "../../config/env";
import { AppError } from "../errors/AppError";

export type AccessPayload = { sub: string; role: Role };
export type RefreshPayload = { sub: string; jti: string; exp: number };

type Ttl = NonNullable<SignOptions["expiresIn"]>;

export const signAccessToken = (payload: AccessPayload) =>
  jwt.sign(payload, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as Ttl });

export const signRefreshToken = (userId: string) =>
  jwt.sign({ sub: userId }, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_TTL as Ttl,
    jwtid: randomUUID(),
  });

function verify<T>(token: string, secret: string): T {
  try {
    return jwt.verify(token, secret) as T;
  } catch {
    throw new AppError(401, "Invalid or expired token");
  }
}

export const verifyAccessToken = (token: string) =>
  verify<AccessPayload>(token, env.JWT_ACCESS_SECRET);

export const verifyRefreshToken = (token: string) => {
  const payload = verify<Partial<RefreshPayload>>(token, env.JWT_REFRESH_SECRET);
  if (!payload.sub || !payload.jti || !payload.exp) {
    throw new AppError(401, "Invalid or expired token");
  }
  return payload as RefreshPayload;
};
