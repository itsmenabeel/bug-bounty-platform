import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import { reportSelect } from "./report.select";
import type { CreateReportInput, ListReportsQuery, UpdateReportInput } from "./report.validation";

type Actor = { id: string; role: Role };

const EDITABLE_STATUSES = ["NEW", "NEEDS_INFO"] as const;

// Researchers see their own reports, owners see reports on their programs, admins see all.
function visibleTo(actor: Actor): Prisma.ReportWhereInput {
  if (actor.role === ROLES.ADMIN) return {};
  if (actor.role === ROLES.PROGRAM_OWNER) return { program: { ownerId: actor.id } };
  return { researcherId: actor.id };
}

export async function createReport(researcherId: string, input: CreateReportInput) {
  const program = await prisma.program.findFirst({
    where: { id: input.programId, deletedAt: null },
    select: { status: true },
  });
  if (!program || program.status === "DRAFT") throw new AppError(404, "Program not found");
  if (program.status !== "ACTIVE") throw new AppError(409, "Program is not accepting reports");

  return prisma.report.create({ data: { researcherId, ...input }, select: reportSelect });
}

export async function listReports(actor: Actor, query: ListReportsQuery) {
  const where: Prisma.ReportWhereInput = {
    deletedAt: null,
    ...visibleTo(actor),
    ...(query.status && { status: query.status }),
    ...(query.severity && { severity: query.severity }),
    ...(query.programId && { programId: query.programId }),
    ...(query.search && { title: { contains: query.search, mode: "insensitive" } }),
  };

  const [total, items] = await prisma.$transaction([
    prisma.report.count({ where }),
    prisma.report.findMany({ where, select: reportSelect, ...applyPagination(query) }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

export async function getReport(id: string, actor: Actor) {
  const report = await prisma.report.findFirst({
    where: { id, deletedAt: null, ...visibleTo(actor) },
    select: reportSelect,
  });
  if (!report) throw new AppError(404, "Report not found");
  return report;
}

// Someone else's report is a 404, so its existence is not revealed.
async function assertOwnEditable(id: string, researcherId: string) {
  const report = await prisma.report.findFirst({
    where: { id, researcherId, deletedAt: null },
    select: { status: true },
  });
  if (!report) throw new AppError(404, "Report not found");
  if (!EDITABLE_STATUSES.some((status) => status === report.status)) {
    throw new AppError(409, `A report in ${report.status} status cannot be changed`);
  }
}

// The status filter keeps a concurrent triage change from being overwritten.
const editableWhere = (id: string, researcherId: string): Prisma.ReportWhereInput => ({
  id,
  researcherId,
  deletedAt: null,
  status: { in: [...EDITABLE_STATUSES] },
});

export async function updateReport(id: string, researcherId: string, input: UpdateReportInput) {
  await assertOwnEditable(id, researcherId);

  const updated = await prisma.report.updateMany({
    where: editableWhere(id, researcherId),
    data: input,
  });
  if (updated.count === 0) throw new AppError(409, "Report status changed, please retry");

  return getReport(id, { id: researcherId, role: ROLES.RESEARCHER });
}

export async function deleteReport(id: string, researcherId: string) {
  await assertOwnEditable(id, researcherId);

  const deleted = await prisma.report.updateMany({
    where: editableWhere(id, researcherId),
    data: { deletedAt: new Date() },
  });
  if (deleted.count === 0) throw new AppError(409, "Report status changed, please retry");
}
