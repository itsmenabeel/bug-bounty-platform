import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../shared/errors/AppError";

type Mapped = { statusCode: number; message: string; errors: unknown[] };

const PRISMA_ERRORS: Record<string, { statusCode: number; message: string }> = {
  P2002: { statusCode: 409, message: "Resource already exists" },
  P2003: { statusCode: 409, message: "Related resource is missing or still in use" },
  P2025: { statusCode: 404, message: "Resource not found" },
  P2034: { statusCode: 409, message: "Conflicting update, please retry" },
  P2024: { statusCode: 503, message: "Service is busy, please retry" },
  P2028: { statusCode: 503, message: "Service is busy, please retry" },
};

const HTTP_MESSAGES: Record<number, string> = {
  400: "Bad request",
  413: "Request body is too large",
  415: "Unsupported media type",
};

// Errors raised by Express and body-parser carry an HTTP status of their own.
function httpStatusOf(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("status" in error)) return null;
  const { status } = error as { status: unknown };
  return typeof status === "number" && status >= 400 && status < 500 ? status : null;
}

function mapError(error: unknown): Mapped | null {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, message: error.message, errors: error.errors };
  }
  if (error instanceof z.ZodError) {
    const errors = error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    return { statusCode: 422, message: "Validation failed", errors };
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError && PRISMA_ERRORS[error.code]) {
    return { ...PRISMA_ERRORS[error.code], errors: [] };
  }
  if (error instanceof SyntaxError && "body" in error) {
    return { statusCode: 400, message: "Malformed JSON body", errors: [] };
  }
  const status = httpStatusOf(error);
  if (status) {
    return { statusCode: status, message: HTTP_MESSAGES[status] ?? "Bad request", errors: [] };
  }
  return null;
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const mapped = mapError(error);
  if (!mapped) {
    console.error(error);
    res.status(500).json({ success: false, message: "Internal server error", errors: [] });
    return;
  }
  const { statusCode, message, errors } = mapped;
  res.status(statusCode).json({ success: false, message, errors });
};
