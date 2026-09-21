import type { Prisma, ReportStatus } from "@prisma/client";
import { REPORT_TRANSITIONS } from "../../shared/constants/reportStatus";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";

export function assertTransition(from: ReportStatus, to: ReportStatus) {
  if (!REPORT_TRANSITIONS[from].includes(to)) {
    throw new AppError(409, `Cannot change report status from ${from} to ${to}`);
  }
}

type TransitionParams = {
  reportId: string;
  actorId: string;
  from: ReportStatus;
  to: ReportStatus;
  // Extra columns to set together with the status, such as severity.
  data?: Prisma.ReportUncheckedUpdateManyInput;
  metadata?: Record<string, Prisma.InputJsonValue>;
};

/** The only place a report's status changes. Run it inside the caller's transaction. */
export async function transitionReport(tx: Prisma.TransactionClient, params: TransitionParams) {
  const { reportId, actorId, from, to, data, metadata } = params;
  assertTransition(from, to);

  // Matching on the current status makes a concurrent change fail instead of overwrite.
  const updated = await tx.report.updateMany({
    where: { id: reportId, status: from, deletedAt: null },
    data: { ...data, status: to },
  });
  if (updated.count === 0) throw new AppError(409, "Report status changed, please retry");

  await writeAudit(tx, {
    actorId,
    action: "REPORT_STATUS_CHANGE",
    entityType: "Report",
    entityId: reportId,
    metadata: { from, to, ...metadata },
  });
}
