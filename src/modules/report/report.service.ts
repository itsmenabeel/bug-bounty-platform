import type { Prisma, Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import { reportSelect } from "./report.select";
import { assertTransition, transitionReport } from "./report.transition";
import type {
  CreateReportInput,
  ListReportsQuery,
  TriageReportInput,
  UpdateReportInput,
} from "./report.validation";

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
  return report.status;
}

// The status filter keeps a concurrent triage change from being overwritten.
const editableWhere = (id: string, researcherId: string): Prisma.ReportWhereInput => ({
  id,
  researcherId,
  deletedAt: null,
  status: { in: [...EDITABLE_STATUSES] },
});

export async function updateReport(id: string, researcherId: string, input: UpdateReportInput) {
  const status = await assertOwnEditable(id, researcherId);

  await prisma.$transaction(async (tx) => {
    const updated = await tx.report.updateMany({
      where: editableWhere(id, researcherId),
      data: input,
    });
    if (updated.count === 0) throw new AppError(409, "Report status changed, please retry");

    // Answering an information request puts the report back in the triage queue.
    if (status === "NEEDS_INFO") {
      await transitionReport(tx, {
        reportId: id,
        actorId: researcherId,
        from: "NEEDS_INFO",
        to: "TRIAGING",
        metadata: { reason: "researcher_update" },
      });
    }
  });

  return getReport(id, { id: researcherId, role: ROLES.RESEARCHER });
}

export async function deleteReport(id: string, researcherId: string) {
  await assertOwnEditable(id, researcherId);

  await prisma.$transaction(async (tx) => {
    const deleted = await tx.report.updateMany({
      where: editableWhere(id, researcherId),
      data: { deletedAt: new Date() },
    });
    if (deleted.count === 0) throw new AppError(409, "Report status changed, please retry");

    await writeAudit(tx, {
      actorId: researcherId,
      action: "REPORT_DELETED",
      entityType: "Report",
      entityId: id,
    });
  });
}

export async function triageReport(id: string, actor: Actor, input: TriageReportInput) {
  const report = await prisma.report.findFirst({
    where: { id, deletedAt: null },
    select: { status: true, severity: true, programId: true },
  });
  if (!report) throw new AppError(404, "Report not found");

  const next = input.status;
  assertTransition(report.status, next);

  const severity = input.severity ?? report.severity;
  if (next === "ACCEPTED") {
    if (!severity) throw new AppError(422, "Severity is required to accept a report");
    const tier = await prisma.rewardTier.findUnique({
      where: { programId_severity: { programId: report.programId, severity } },
    });
    if (!tier) throw new AppError(409, `The program has no reward tier for ${severity}`);
  }
  if (next === "DUPLICATE" && input.duplicateOfId) {
    await assertValidOriginal(id, report.programId, input.duplicateOfId);
  }

  await prisma.$transaction((tx) =>
    transitionReport(tx, {
      reportId: id,
      actorId: actor.id,
      from: report.status,
      to: next,
      data: { severity, duplicateOfId: input.duplicateOfId },
      metadata: { ...(input.note && { note: input.note }), ...(severity && { severity }) },
    }),
  );

  return getReport(id, actor);
}

async function assertValidOriginal(reportId: string, programId: string, originalId: string) {
  if (originalId === reportId) throw new AppError(422, "A report cannot duplicate itself");

  const original = await prisma.report.findFirst({
    where: { id: originalId, programId, deletedAt: null, duplicateOfId: null },
    select: { id: true },
  });
  if (!original) {
    throw new AppError(
      422,
      "Original report must exist in the same program and not be a duplicate",
    );
  }
}
