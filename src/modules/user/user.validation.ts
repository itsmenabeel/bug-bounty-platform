import { z } from "zod";

// strictObject rejects unknown keys, so role or walletBalance cannot be smuggled in.
export const updateProfileSchema = z.object({
  body: z.strictObject({ name: z.string().trim().min(2).max(100) }),
});

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>["body"];
