import { z } from "zod";
import { paginationQuery } from "../../shared/utils/pagination";

export const listAuditLogsSchema = z.object({
  query: paginationQuery(["createdAt"], "createdAt").extend({
    action: z.string().trim().min(1).max(100).optional(),
    entityType: z.string().trim().min(1).max(50).optional(),
    entityId: z.uuid("Invalid entity id").optional(),
    actorId: z.uuid("Invalid actor id").optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});

export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>["query"];
