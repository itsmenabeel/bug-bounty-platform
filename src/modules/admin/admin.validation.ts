import { z } from "zod";
import { ROLES } from "../../shared/constants/roles";
import { paginationQuery } from "../../shared/utils/pagination";

export const listAuditLogsSchema = z.object({
  query: paginationQuery(["createdAt"], "createdAt")
    .extend({
      action: z.string().trim().min(1).max(100).optional(),
      entityType: z.string().trim().min(1).max(50).optional(),
      entityId: z.uuid("Invalid entity id").optional(),
      actorId: z.uuid("Invalid actor id").optional(),
      from: z.coerce.date().optional(),
      to: z.coerce.date().optional(),
    })
    .refine((query) => !query.from || !query.to || query.from <= query.to, {
      message: "from must not be after to",
      path: ["from"],
    }),
});

export const listUsersSchema = z.object({
  query: paginationQuery(["createdAt", "name", "email", "reputation"], "createdAt").extend({
    role: z.enum(ROLES).optional(),
    isActive: z
      .enum(["true", "false"])
      .transform((value) => value === "true")
      .optional(),
    search: z.string().trim().min(1).max(100).optional(),
  }),
});

const userIdParams = z.object({ id: z.uuid("Invalid id") });

export const updateUserRoleSchema = z.object({
  params: userIdParams,
  body: z.strictObject({ role: z.enum(ROLES) }),
});

export const updateUserStatusSchema = z.object({
  params: userIdParams,
  body: z.strictObject({
    isActive: z.boolean(),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
});

export type ListUsersQuery = z.infer<typeof listUsersSchema>["query"];
export type UpdateUserRoleInput = z.infer<typeof updateUserRoleSchema>["body"];
export type UpdateUserStatusInput = z.infer<typeof updateUserStatusSchema>["body"];
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsSchema>["query"];
