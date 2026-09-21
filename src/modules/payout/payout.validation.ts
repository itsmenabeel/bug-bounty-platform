import { z } from "zod";
import { paginationQuery } from "../../shared/utils/pagination";

export const listPayoutsSchema = z.object({
  query: paginationQuery(["createdAt", "amount"], "createdAt").extend({
    programId: z.uuid("Invalid program id").optional(),
  }),
});

export type ListPayoutsQuery = z.infer<typeof listPayoutsSchema>["query"];
