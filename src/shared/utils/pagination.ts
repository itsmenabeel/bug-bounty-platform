import { z } from "zod";
import { DEFAULT_LIMIT, DEFAULT_PAGE, MAX_LIMIT } from "../constants/pagination";
import type { PaginationMeta } from "./sendResponse";

/** Zod fragment for ?page&limit&sortBy&order. Sort fields are whitelisted per resource. */
export function paginationQuery<const F extends readonly [string, ...string[]]>(
  sortFields: F,
  defaultSort: F[number],
  defaultOrder: "asc" | "desc" = "desc",
) {
  return z.object({
    page: z.coerce.number().int().min(1).default(DEFAULT_PAGE),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    sortBy: z.enum(sortFields).default(defaultSort),
    order: z.enum(["asc", "desc"]).default(defaultOrder),
  });
}

type PaginationQuery = { page: number; limit: number; sortBy: string; order: "asc" | "desc" };

export function applyPagination({ page, limit, sortBy, order }: PaginationQuery) {
  return {
    skip: (page - 1) * limit,
    take: limit,
    orderBy: { [sortBy]: order },
  };
}

export function buildMeta(page: number, limit: number, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}
