import { z } from "zod";

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

export type CreateProgramInput = z.infer<typeof createProgramSchema>["body"];
export type UpdateProgramInput = z.infer<typeof updateProgramSchema>["body"];
