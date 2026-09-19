import type { Response } from "express";

export type PaginationMeta = { page: number; limit: number; total: number; totalPages: number };

type Options<T> = {
  statusCode?: number;
  message: string;
  data?: T;
  meta?: PaginationMeta;
};

export function sendResponse<T>(
  res: Response,
  { statusCode = 200, message, data, meta }: Options<T>,
) {
  res
    .status(statusCode)
    .json({ success: true, message, data: data ?? null, ...(meta && { meta }) });
}
