import { ReportStatus } from "@prisma/client";

export const REPORT_STATUS = ReportStatus;

// Legal edges of the report state machine. Terminal states map to nothing.
export const REPORT_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  NEW: ["TRIAGING", "REJECTED", "DUPLICATE"],
  TRIAGING: ["ACCEPTED", "NEEDS_INFO", "REJECTED", "DUPLICATE"],
  NEEDS_INFO: ["TRIAGING"],
  ACCEPTED: ["REWARDED"],
  DUPLICATE: [],
  REJECTED: [],
  REWARDED: [],
};
