import { Prisma } from "@prisma/client";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../shared/errors/AppError";

type Mapped = { statusCode: number; message: string; errors: unknown[] };

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
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return { statusCode: 409, message: "Resource already exists", errors: [] };
    }
    if (error.code === "P2025") {
      return { statusCode: 404, message: "Resource not found", errors: [] };
    }
  }
  if (error instanceof SyntaxError && "body" in error) {
    return { statusCode: 400, message: "Malformed JSON body", errors: [] };
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
