import type { Request } from "express";
import { AppError } from "../errors/AppError";

// For handlers behind authenticate, where req.user is always set.
export function requireUser(req: Request) {
  if (!req.user) throw new AppError(401, "Authentication required");
  return req.user;
}
