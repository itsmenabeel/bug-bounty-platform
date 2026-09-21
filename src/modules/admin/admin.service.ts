import type { Prisma } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import type { ListAuditLogsQuery } from "./admin.validation";

export async function listAuditLogs(query: ListAuditLogsQuery) {
  const where: Prisma.AuditLogWhereInput = {
    ...(query.action && { action: query.action }),
    ...(query.entityType && { entityType: query.entityType }),
    ...(query.entityId && { entityId: query.entityId }),
    ...(query.actorId && { actorId: query.actorId }),
    ...((query.from || query.to) && { createdAt: { gte: query.from, lte: query.to } }),
  };

  const [total, items] = await prisma.$transaction([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        metadata: true,
        createdAt: true,
        actor: { select: { id: true, name: true, role: true } },
      },
      ...applyPagination(query),
    }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}
