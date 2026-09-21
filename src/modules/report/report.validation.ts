import { Severity } from "@prisma/client";
import { z } from "zod";
import { REPORT_STATUS } from "../../shared/constants/reportStatus";
import { paginationQuery } from "../../shared/utils/pagination";

const title = z.string().trim().min(5).max(200);
const description = z.string().trim().min(20).max(20000);

export const createReportSchema = z.object({
  body: z.strictObject({ programId: z.uuid("Invalid program id"), title, description }),
});

export const updateReportSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
  body: z
    .strictObject({ title, description })
    .partial()
    .refine((body) => Object.keys(body).length > 0, "Provide at least one field to update"),
});

export const listReportsSchema = z.object({
  query: paginationQuery(["createdAt", "updatedAt", "title"], "createdAt").extend({
    status: z.enum(REPORT_STATUS).optional(),
    severity: z.enum(Severity).optional(),
    programId: z.uuid("Invalid program id").optional(),
    search: z.string().trim().min(1).max(100).optional(),
  }),
});

export const triageReportSchema = z.object({
  params: z.object({ id: z.uuid("Invalid id") }),
  body: z
    .strictObject({
      // REWARDED is reached only through the payout endpoint.
      status: z.enum([
        REPORT_STATUS.TRIAGING,
        REPORT_STATUS.NEEDS_INFO,
        REPORT_STATUS.ACCEPTED,
        REPORT_STATUS.REJECTED,
        REPORT_STATUS.DUPLICATE,
      ]),
      severity: z.enum(Severity).optional(),
      duplicateOfId: z.uuid("Invalid report id").optional(),
      note: z.string().trim().min(1).max(1000).optional(),
    })
    .superRefine((body, ctx) => {
      const isDuplicate = body.status === REPORT_STATUS.DUPLICATE;
      if (isDuplicate && !body.duplicateOfId) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateOfId"],
          message: "Required for DUPLICATE",
        });
      }
      if (!isDuplicate && body.duplicateOfId) {
        ctx.addIssue({
          code: "custom",
          path: ["duplicateOfId"],
          message: "Only valid for DUPLICATE",
        });
      }
    }),
});

export type TriageReportInput = z.infer<typeof triageReportSchema>["body"];
export type CreateReportInput = z.infer<typeof createReportSchema>["body"];
export type UpdateReportInput = z.infer<typeof updateReportSchema>["body"];
export type ListReportsQuery = z.infer<typeof listReportsSchema>["query"];
