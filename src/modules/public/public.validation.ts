import { z } from "zod";
import { paginationQuery } from "../../shared/utils/pagination";

// Same fields as the signed-in list minus status and mine, which Zod strips.
export const listPublicProgramsSchema = z.object({
  query: paginationQuery(["createdAt", "title", "poolBalance"], "createdAt").extend({
    search: z.string().trim().min(1).max(100).optional(),
  }),
});

export type ListPublicProgramsQuery = z.infer<typeof listPublicProgramsSchema>["query"];
