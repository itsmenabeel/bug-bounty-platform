import type { RequestHandler } from "express";
import { AppError } from "../shared/errors/AppError";

// Postgres cannot store NUL characters in text, so they would surface as a 500.
export const rejectNullBytes: RequestHandler = (req, _res, next) => {
  const inBody =
    typeof req.body === "object" &&
    req.body !== null &&
    !Buffer.isBuffer(req.body) &&
    JSON.stringify(req.body).includes("\\u0000");
  const inUrl = /%00/i.test(req.originalUrl);

  if (inBody || inUrl) return next(new AppError(400, "Input must not contain null characters"));
  next();
};
