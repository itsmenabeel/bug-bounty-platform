import type { Severity } from "@prisma/client";

// Reputation points a researcher earns for a rewarded report, by severity.
export const REPUTATION_WEIGHT: Record<Severity, number> = {
  LOW: 1,
  MEDIUM: 3,
  HIGH: 7,
  CRITICAL: 15,
};
