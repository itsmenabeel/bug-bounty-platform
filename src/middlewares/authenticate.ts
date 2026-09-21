import type { RequestHandler } from "express";
import { prisma } from "../config/prisma";
import { AppError } from "../shared/errors/AppError";
import { catchAsync } from "../shared/utils/catchAsync";
import { verifyAccessToken } from "../shared/utils/jwt";

export const authenticate: RequestHandler = catchAsync(async (req, _res, next) => {
  const [scheme, token] = req.headers.authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) {
    throw new AppError(401, "Authentication required");
  }

  const { sub } = verifyAccessToken(token);

  // Read role and status from the database so bans and role changes apply immediately.
  const user = await prisma.user.findFirst({
    where: { id: sub, deletedAt: null, isActive: true },
    select: { id: true, role: true },
  });
  if (!user) throw new AppError(401, "Account not found or disabled");

  req.user = user;
  next();
});
