import { type Prisma, ProgramStatus, ReportStatus, type Role, Severity } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { PROGRAMS_CACHE_NAMESPACE } from "../../shared/constants/cache";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";
import { invalidate } from "../../shared/utils/cache";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import { publicUserSelect } from "../user/user.select";
import type {
  ListAuditLogsQuery,
  ListUsersQuery,
  UpdateUserRoleInput,
  UpdateUserStatusInput,
} from "./admin.validation";

type Actor = { id: string; role: Role };

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

export async function listUsers(query: ListUsersQuery) {
  const where: Prisma.UserWhereInput = {
    deletedAt: null,
    ...(query.role && { role: query.role }),
    ...(query.isActive !== undefined && { isActive: query.isActive }),
    ...(query.search && {
      OR: [
        { name: { contains: query.search, mode: "insensitive" } },
        { email: { contains: query.search, mode: "insensitive" } },
      ],
    }),
  };

  const [total, items] = await prisma.$transaction([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, select: publicUserSelect, ...applyPagination(query) }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

async function getTarget(actor: Actor, targetId: string, action: string) {
  if (targetId === actor.id) throw new AppError(409, `You cannot ${action} your own account`);

  const target = await prisma.user.findFirst({
    where: { id: targetId, deletedAt: null },
    select: { id: true, role: true, isActive: true },
  });
  if (!target) throw new AppError(404, "User not found");
  return target;
}

const readUser = (id: string) =>
  prisma.user.findUniqueOrThrow({ where: { id }, select: publicUserSelect });

const ADMIN_GUARD_LOCK_KEY = 4_815_162;

/**
 * Keeps at least one other active admin. The advisory lock serialises every change
 * that could remove an admin, so two admins cannot demote or ban each other at once.
 */
async function assertAnotherAdminRemains(tx: Prisma.TransactionClient, targetId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${ADMIN_GUARD_LOCK_KEY})`;
  const others = await tx.user.count({
    where: { role: ROLES.ADMIN, isActive: true, deletedAt: null, id: { not: targetId } },
  });
  if (others === 0) throw new AppError(409, "At least one other active admin must remain");
}

export async function updateUserRole(actor: Actor, targetId: string, input: UpdateUserRoleInput) {
  const target = await getTarget(actor, targetId, "change the role of");
  if (target.role === input.role) return readUser(targetId);

  // Demoting an owner would strand their programs and any funded pools.
  if (target.role === ROLES.PROGRAM_OWNER) {
    const programs = await prisma.program.count({ where: { ownerId: targetId, deletedAt: null } });
    if (programs > 0) {
      throw new AppError(
        409,
        "This user owns programs. Delete or close them before changing the role",
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (target.role === ROLES.ADMIN) await assertAnotherAdminRemains(tx, targetId);

    // Matching on the current role stops two admins from overwriting each other.
    const updated = await tx.user.updateMany({
      where: { id: targetId, role: target.role, deletedAt: null },
      data: { role: input.role },
    });
    if (updated.count === 0) throw new AppError(409, "User changed, please retry");

    await writeAudit(tx, {
      actorId: actor.id,
      action: "ROLE_UPDATED",
      entityType: "User",
      entityId: targetId,
      metadata: { from: target.role, to: input.role },
    });
  });
  return readUser(targetId);
}

export async function updateUserStatus(
  actor: Actor,
  targetId: string,
  input: UpdateUserStatusInput,
) {
  const target = await getTarget(actor, targetId, "ban or unban");
  if (target.isActive === input.isActive) {
    return { ...(await readUser(targetId)), pausedPrograms: 0 };
  }

  const pausedPrograms = await prisma.$transaction(async (tx) => {
    if (target.role === ROLES.ADMIN && !input.isActive) {
      await assertAnotherAdminRemains(tx, targetId);
    }

    const updated = await tx.user.updateMany({
      where: { id: targetId, isActive: target.isActive, deletedAt: null },
      data: { isActive: input.isActive },
    });
    if (updated.count === 0) throw new AppError(409, "User changed, please retry");

    // Unbanning does not resume programs. The owner reactivates them.
    const paused = input.isActive ? [] : await pauseActivePrograms(tx, actor.id, targetId);

    await writeAudit(tx, {
      actorId: actor.id,
      action: input.isActive ? "USER_UNBANNED" : "USER_BANNED",
      entityType: "User",
      entityId: targetId,
      metadata: { ...(input.reason && { reason: input.reason }), pausedPrograms: paused.length },
    });
    return paused.length;
  });

  if (pausedPrograms > 0) await invalidate(PROGRAMS_CACHE_NAMESPACE);
  return { ...(await readUser(targetId)), pausedPrograms };
}

// A banned owner cannot manage their programs, so they stop accepting reports.
async function pauseActivePrograms(tx: Prisma.TransactionClient, actorId: string, ownerId: string) {
  const programs = await tx.program.findMany({
    where: { ownerId, status: "ACTIVE", deletedAt: null },
    select: { id: true },
  });
  if (programs.length === 0) return [];

  await tx.program.updateMany({
    where: { id: { in: programs.map((program) => program.id) }, status: "ACTIVE" },
    data: { status: "PAUSED" },
  });
  for (const { id } of programs) {
    await writeAudit(tx, {
      actorId,
      action: "PROGRAM_STATUS_CHANGE",
      entityType: "Program",
      entityId: id,
      metadata: { from: "ACTIVE", to: "PAUSED", reason: "owner_banned" },
    });
  }
  return programs;
}

type CountRow<K> = { key: K | null; count: number };

// Every enum value appears in the result, including the ones with zero rows.
function countsByKey<K extends string>(keys: readonly K[], rows: CountRow<K>[]) {
  return Object.fromEntries(
    keys.map((key) => [key, rows.find((row) => row.key === key)?.count ?? 0]),
  ) as Record<K, number>;
}

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

export async function getDashboardStats() {
  const live = { deletedAt: null };
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    usersByRole,
    bannedUsers,
    programsByStatus,
    poolTotal,
    reportsByStatus,
    reportsBySeverity,
    reportsLastWeek,
    funded,
    paidOut,
    pendingPayments,
  ] = await prisma.$transaction([
    prisma.user.groupBy({
      by: ["role"],
      where: live,
      orderBy: { role: "asc" },
      _count: { _all: true },
    }),
    prisma.user.count({ where: { ...live, isActive: false } }),
    prisma.program.groupBy({
      by: ["status"],
      where: live,
      orderBy: { status: "asc" },
      _count: { _all: true },
    }),
    prisma.program.aggregate({ where: live, _sum: { poolBalance: true } }),
    prisma.report.groupBy({
      by: ["status"],
      where: live,
      orderBy: { status: "asc" },
      _count: { _all: true },
    }),
    prisma.report.groupBy({
      by: ["severity"],
      where: live,
      orderBy: { severity: "asc" },
      _count: { _all: true },
    }),
    prisma.report.count({ where: { ...live, createdAt: { gte: weekAgo } } }),
    prisma.payment.aggregate({ where: { status: "SUCCEEDED" }, _sum: { amount: true } }),
    prisma.payout.aggregate({ _sum: { amount: true }, _count: { _all: true } }),
    prisma.payment.count({ where: { status: "PENDING" } }),
  ]);

  const byRole = countsByKey(
    Object.values(ROLES),
    usersByRole.map((row) => ({ key: row.role, count: row._count._all })),
  );
  const byProgramStatus = countsByKey(
    Object.values(ProgramStatus),
    programsByStatus.map((row) => ({ key: row.status, count: row._count._all })),
  );
  const byReportStatus = countsByKey(
    Object.values(ReportStatus),
    reportsByStatus.map((row) => ({ key: row.status, count: row._count._all })),
  );
  const bySeverity = countsByKey(
    Object.values(Severity),
    reportsBySeverity.map((row) => ({ key: row.severity, count: row._count._all })),
  );

  return {
    users: { total: sum(Object.values(byRole)), banned: bannedUsers, byRole },
    programs: {
      total: sum(Object.values(byProgramStatus)),
      byStatus: byProgramStatus,
      totalPoolBalance: poolTotal._sum.poolBalance ?? 0,
    },
    reports: {
      total: sum(Object.values(byReportStatus)),
      byStatus: byReportStatus,
      // Reports not yet triaged have no severity, so this covers triaged ones only.
      bySeverity,
      createdLast7Days: reportsLastWeek,
    },
    money: {
      totalFunded: funded._sum.amount ?? 0,
      totalPaidOut: paidOut._sum.amount ?? 0,
      payoutCount: paidOut._count._all,
      pendingPayments,
    },
  };
}
