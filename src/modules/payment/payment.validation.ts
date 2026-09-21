import { PaymentStatus } from "@prisma/client";
import { z } from "zod";
import { MAX_FUNDING_AMOUNT, MIN_FUNDING_AMOUNT } from "../../shared/constants/payment";
import { paginationQuery } from "../../shared/utils/pagination";

export const createCheckoutSchema = z.object({
  body: z.strictObject({
    programId: z.uuid("Invalid program id"),
    // Integer cents.
    amount: z.number().int().min(MIN_FUNDING_AMOUNT).max(MAX_FUNDING_AMOUNT),
  }),
});

export const listPaymentsSchema = z.object({
  query: paginationQuery(["createdAt", "amount"], "createdAt").extend({
    status: z.enum(PaymentStatus).optional(),
    programId: z.uuid("Invalid program id").optional(),
    // The success redirect carries this id, so a page can look its payment up.
    sessionId: z.string().trim().min(1).max(255).optional(),
  }),
});

export type ListPaymentsQuery = z.infer<typeof listPaymentsSchema>["query"];
export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>["body"];
