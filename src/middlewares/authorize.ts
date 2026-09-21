import type { Role } from "@prisma/client";
import type { RequestHandler } from "express";
import { AppError } from "../shared/errors/AppError";

// Coarse role gate. Ownership checks live in the services.
export const authorize =
  (...roles: Role[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.user) return next(new AppError(401, "Authentication required"));
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, "You do not have permission to perform this action"));
    }
    next();
  };
