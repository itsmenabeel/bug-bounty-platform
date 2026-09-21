import { ProgramStatus } from "@prisma/client";

export const PROGRAM_STATUS = ProgramStatus;

// Legal program status changes. CLOSED is terminal.
export const PROGRAM_TRANSITIONS: Record<ProgramStatus, ProgramStatus[]> = {
  DRAFT: ["ACTIVE", "CLOSED"],
  ACTIVE: ["PAUSED", "CLOSED"],
  PAUSED: ["ACTIVE", "CLOSED"],
  CLOSED: [],
};
