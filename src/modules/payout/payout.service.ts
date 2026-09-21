import { Prisma, type Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { REPUTATION_WEIGHT } from "../../shared/constants/reputation";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import { assertTransition, transitionReport } from "../report/report.transition";
import type { ListPayoutsQuery } from "./payout.validation";

type Actor = { id: string; role: Role };

const alreadyRewarded = () =>
  new AppError(409, "This report has already been rewarded", [{ code: "ALREADY_REWARDED" }]);

const insufficientPool = () =>
  new AppError(409, "The program pool cannot cover this reward", [{ code: "INSUFFICIENT_POOL" }]);

/**
 * Pays out an accepted report. The pool debit is one conditional UPDATE, so the
 * balance check and the write cannot be separated by another request. The unique
 * Payout.reportId rejects a second payout for the same report. Both run in one
 * transaction, so a failure after the debit rolls the debit back.
 */
export async function rewardReport(reportId: string, actor: Actor) {
  const report = await prisma.report.findFirst({
    where: { id: reportId, deletedAt: null },
    select: { status: true, severity: true, programId: true, researcherId: true },
  });
  if (!report) throw new AppError(404, "Report not found");
  if (report.status === "REWARDED") throw alreadyRewarded();
  assertTransition(report.status, "REWARDED");
  if (!report.severity) throw new AppError(409, "Report has no confirmed severity");

  const { severity, programId, researcherId } = report;
  const tier = await prisma.rewardTier.findUnique({
    where: { programId_severity: { programId, severity } },
  });
  if (!tier) throw new AppError(409, `The program has no reward tier for ${severity}`);
  const amount = tier.amount;

  try {
    return await prisma.$transaction(
      async (tx) => {
        const debited = await tx.program.updateMany({
          where: { id: programId, deletedAt: null, poolBalance: { gte: amount } },
          data: { poolBalance: { decrement: amount } },
        });
        if (debited.count === 0) throw insufficientPool();

        const payout = await tx.payout.create({
          data: { reportId, researcherId, programId, amount },
          select: { id: true, reportId: true, amount: true, status: true, createdAt: true },
        });

        const researcher = await tx.user.update({
          where: { id: researcherId },
          data: {
            walletBalance: { increment: amount },
            reputation: { increment: REPUTATION_WEIGHT[severity] },
          },
          select: { id: true, walletBalance: true, reputation: true },
        });

        await transitionReport(tx, {
          reportId,
          actorId: actor.id,
          from: "ACCEPTED",
          to: "REWARDED",
          metadata: { amount },
        });

        await writeAudit(tx, {
          actorId: actor.id,
          action: "PAYOUT_ISSUED",
          entityType: "Report",
          entityId: reportId,
          metadata: { payoutId: payout.id, amount, programId, researcherId },
        });

        const program = await tx.program.findUniqueOrThrow({
          where: { id: programId },
          select: { id: true, poolBalance: true },
        });
        return { payout, program, researcher, report: { id: reportId, status: "REWARDED" } };
      },
      { maxWait: 5000, timeout: 15000 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw alreadyRewarded();
    }
    throw error;
  }
}

// Researchers see their own payouts, owners see payouts on their programs, admins see all.
function visibleTo(actor: Actor): Prisma.PayoutWhereInput {
  if (actor.role === ROLES.ADMIN) return {};
  if (actor.role === ROLES.PROGRAM_OWNER) return { program: { ownerId: actor.id } };
  return { researcherId: actor.id };
}

export async function listPayouts(actor: Actor, query: ListPayoutsQuery) {
  const where: Prisma.PayoutWhereInput = {
    ...visibleTo(actor),
    ...(query.programId && { programId: query.programId }),
  };

  const [total, items] = await prisma.$transaction([
    prisma.payout.count({ where }),
    prisma.payout.findMany({
      where,
      select: {
        id: true,
        amount: true,
        status: true,
        createdAt: true,
        report: { select: { id: true, title: true } },
        program: { select: { id: true, title: true } },
        researcher: { select: { id: true, name: true } },
      },
      ...applyPagination(query),
    }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}
