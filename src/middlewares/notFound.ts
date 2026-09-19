import type { RequestHandler } from "express";
import { AppError } from "../shared/errors/AppError";

export const notFound: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Route not found: ${req.method} ${req.originalUrl}`));
};
