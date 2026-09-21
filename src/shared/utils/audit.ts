import type { Prisma } from "@prisma/client";

type AuditEntry = {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata?: Prisma.InputJsonValue;
};

// Takes the caller's transaction client so the log commits or rolls back with the change.
export function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  return tx.auditLog.create({ data: entry });
}
