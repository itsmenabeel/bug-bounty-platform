import { z } from "zod";
import { MAX_FUNDING_AMOUNT, MIN_FUNDING_AMOUNT } from "../../shared/constants/payment";

export const createCheckoutSchema = z.object({
  body: z.strictObject({
    programId: z.uuid("Invalid program id"),
    // Integer cents.
    amount: z.number().int().min(MIN_FUNDING_AMOUNT).max(MAX_FUNDING_AMOUNT),
  }),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>["body"];
