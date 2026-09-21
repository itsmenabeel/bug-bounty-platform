import type { User } from "@prisma/client";
import type { TokenPayload } from "google-auth-library";
import { env } from "../../config/env";
import { googleClient } from "../../config/google";
import { prisma } from "../../config/prisma";
import { AppError } from "../../shared/errors/AppError";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt";
import { hashPassword, verifyPassword } from "../../shared/utils/password";
import { claimToken } from "../../shared/utils/tokenDenylist";
import { publicUserSelect } from "../user/user.select";
import type { GoogleLoginInput, LoginInput, RegisterInput } from "./auth.validation";

export function issueTokens(user: Pick<User, "id" | "role">) {
  return {
    accessToken: signAccessToken({ sub: user.id, role: user.role }),
    refreshToken: signRefreshToken(user.id),
  };
}

export async function register(input: RegisterInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw new AppError(409, "Email is already registered");

  const user = await prisma.user.create({
    data: {
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: await hashPassword(input.password),
    },
    select: publicUserSelect,
  });

  return { user, ...issueTokens(user) };
}

export async function refresh(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);

  // Each refresh token works once. Reuse is rejected.
  if (!(await claimToken(payload.jti, payload.exp))) {
    throw new AppError(401, "Refresh token has already been used or revoked");
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, deletedAt: null, isActive: true },
    select: { id: true, role: true },
  });
  if (!user) throw new AppError(401, "Invalid or expired token");

  return issueTokens(user);
}

export async function logout(refreshToken: string) {
  const payload = verifyRefreshToken(refreshToken);
  await claimToken(payload.jti, payload.exp);
}

async function verifyGoogleToken(idToken: string) {
  if (!googleClient || !env.GOOGLE_CLIENT_ID) {
    throw new AppError(503, "Google login is not configured");
  }

  let payload: TokenPayload | undefined;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AppError(401, "Invalid Google token");
  }

  if (!payload?.sub || !payload.email || !payload.email_verified) {
    throw new AppError(401, "Google account email is not verified");
  }
  return { googleId: payload.sub, email: payload.email.toLowerCase(), name: payload.name };
}

export async function googleLogin(input: GoogleLoginInput) {
  const google = await verifyGoogleToken(input.idToken);

  // Match by Google ID first, then link an existing account with the same verified email.
  let user = await prisma.user.findFirst({
    where: { deletedAt: null, OR: [{ googleId: google.googleId }, { email: google.email }] },
  });

  if (user?.googleId && user.googleId !== google.googleId) {
    throw new AppError(409, "Email is linked to a different Google account");
  }

  if (user && !user.googleId) {
    user = await prisma.user.update({
      where: { id: user.id },
      data: { googleId: google.googleId },
    });
  } else if (!user) {
    user = await prisma.user.create({
      data: {
        email: google.email,
        googleId: google.googleId,
        name: google.name ?? google.email.split("@")[0],
        role: input.role,
      },
    });
  }

  if (!user.isActive) throw new AppError(403, "Account is disabled");

  const publicUser = await prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: publicUserSelect,
  });
  return { user: publicUser, ...issueTokens(publicUser) };
}

export async function login(input: LoginInput) {
  const found = await prisma.user.findFirst({
    where: { email: input.email, deletedAt: null },
  });

  // Same message for unknown email, Google-only account, and wrong password.
  const valid = found?.passwordHash && (await verifyPassword(input.password, found.passwordHash));
  if (!found || !valid) throw new AppError(401, "Invalid email or password");
  if (!found.isActive) throw new AppError(403, "Account is disabled");

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: found.id },
    select: publicUserSelect,
  });
  return { user, ...issueTokens(user) };
}
