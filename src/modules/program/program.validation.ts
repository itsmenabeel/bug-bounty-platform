import { z } from "zod";
import { PROGRAM_STATUS } from "../../shared/constants/programStatus";

const scope = z.object({
  inScope: z.array(z.string().trim().min(1).max(200)).min(1, "At least one in-scope asset"),
  outOfScope: z.array(z.string().trim().min(1).max(200)).default([]),
  rules: z.string().trim().max(5000).optional(),
});

const title = z.string().trim().min(3).max(150);
const description = z.string().trim().min(10).max(10000);

export const createProgramSchema = z.object({
  body: z.strictObject({ title, description, scope }),
});

export const updateProgramSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
  body: z
    .strictObject({ title, description, scope })
    .partial()
    .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update"),
});

const severity = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);

export const setRewardTiersSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
  body: z.strictObject({
    tiers: z
      .array(
        z.strictObject({
          severity,
          // Amounts are integer cents.
          amount: z.number().int().positive().max(100_000_000),
        }),
      )
      .min(1)
      .refine((tiers) => new Set(tiers.map((t) => t.severity)).size === tiers.length, {
        message: "Each severity may appear only once",
      }),
  }),
});

export const updateStatusSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
  body: z.strictObject({
    status: z.enum([PROGRAM_STATUS.ACTIVE, PROGRAM_STATUS.PAUSED, PROGRAM_STATUS.CLOSED]),
  }),
});

export type SetRewardTiersInput = z.infer<typeof setRewardTiersSchema>["body"];
export type UpdateStatusInput = z.infer<typeof updateStatusSchema>["body"];
export type CreateProgramInput = z.infer<typeof createProgramSchema>["body"];
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>["body"];
