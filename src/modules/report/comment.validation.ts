import { z } from "zod";
import { paginationQuery } from "../../shared/utils/pagination";

const params = z.object({ id: z.uuid("Invalid id") });

export const createCommentSchema = z.object({
  params,
  body: z.strictObject({ body: z.string().trim().min(1).max(5000) }),
});

export const listCommentsSchema = z.object({
  params,
  query: paginationQuery(["createdAt"], "createdAt", "asc"),
});

export type CreateCommentInput = z.infer<typeof createCommentSchema>["body"];
export type ListCommentsQuery = z.infer<typeof listCommentsSchema>["query"];
