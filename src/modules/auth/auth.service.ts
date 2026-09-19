import type { User } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { AppError } from "../../shared/errors/AppError";
import { signAccessToken, signRefreshToken } from "../../shared/utils/jwt";
import { hashPassword, verifyPassword } from "../../shared/utils/password";
import { publicUserSelect } from "../user/user.select";
import type { LoginInput, RegisterInput } from "./auth.validation";

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
