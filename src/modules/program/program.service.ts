import type { Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { PROGRAM_TRANSITIONS } from "../../shared/constants/programStatus";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";
import { programSelect } from "./program.select";
import type {
  CreateProgramInput,
  SetRewardTiersInput,
  UpdateProgramInput,
  UpdateStatusInput,
} from "./program.validation";

type Actor = { id: string; role: Role };

const OPEN_REPORT_STATUSES = ["NEW", "TRIAGING", "NEEDS_INFO", "ACCEPTED"] as const;

export function createProgram(ownerId: string, input: CreateProgramInput) {
  return prisma.program.create({
    data: { ownerId, ...input },
    select: programSelect,
  });
}

// Non-active programs are visible only to their owner and admins; others get a 404.
export async function getProgram(id: string, actor: Actor) {
  const program = await prisma.program.findFirst({
    where: { id, deletedAt: null },
    select: programSelect,
  });
  const canSeeAll = actor.role === ROLES.ADMIN || program?.ownerId === actor.id;
  if (!program || (program.status !== "ACTIVE" && !canSeeAll)) {
    throw new AppError(404, "Program not found");
  }
  return program;
}

async function getOwnedProgram(id: string, ownerId: string) {
  const program = await prisma.program.findFirst({ where: { id, deletedAt: null } });
  if (!program) throw new AppError(404, "Program not found");
  if (program.ownerId !== ownerId) throw new AppError(403, "You do not own this program");
  return program;
}

export async function updateProgram(id: string, ownerId: string, input: UpdateProgramInput) {
  const program = await getOwnedProgram(id, ownerId);
  if (program.status === "CLOSED") throw new AppError(409, "A closed program cannot be edited");

  return prisma.program.update({ where: { id }, data: input, select: programSelect });
}

export async function setRewardTiers(id: string, actor: Actor, input: SetRewardTiersInput) {
  const program = await getOwnedProgram(id, actor.id);
  if (program.status === "CLOSED") throw new AppError(409, "A closed program cannot be edited");

  await prisma.$transaction(async (tx) => {
    for (const { severity, amount } of input.tiers) {
      await tx.rewardTier.upsert({
        where: { programId_severity: { programId: id, severity } },
        update: { amount },
        create: { programId: id, severity, amount },
      });
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: "REWARD_TIERS_UPDATED",
      entityType: "Program",
      entityId: id,
      metadata: { tiers: input.tiers },
    });
  });

  return prisma.program.findUniqueOrThrow({ where: { id }, select: programSelect });
}

export async function changeStatus(id: string, actor: Actor, input: UpdateStatusInput) {
  const program = await getOwnedProgram(id, actor.id);
  const next = input.status;

  if (!PROGRAM_TRANSITIONS[program.status].includes(next)) {
    throw new AppError(409, `Cannot change status from ${program.status} to ${next}`);
  }
  if (next === "ACTIVE" && (await prisma.rewardTier.count({ where: { programId: id } })) === 0) {
    throw new AppError(409, "Set reward tiers before activating a program");
  }

  await prisma.$transaction(async (tx) => {
    // Matching on the current status makes a concurrent change fail instead of overwrite.
    const updated = await tx.program.updateMany({
      where: { id, status: program.status, deletedAt: null },
      data: { status: next },
    });
    if (updated.count === 0) throw new AppError(409, "Program status changed, please retry");

    await writeAudit(tx, {
      actorId: actor.id,
      action: "PROGRAM_STATUS_CHANGE",
      entityType: "Program",
      entityId: id,
      metadata: { from: program.status, to: next },
    });
  });

  return prisma.program.findUniqueOrThrow({ where: { id }, select: programSelect });
}

export async function deleteProgram(id: string, ownerId: string) {
  const program = await getOwnedProgram(id, ownerId);

  if (program.poolBalance > 0) {
    throw new AppError(409, "A program with a funded pool cannot be deleted");
  }
  const openReports = await prisma.report.count({
    where: { programId: id, deletedAt: null, status: { in: [...OPEN_REPORT_STATUSES] } },
  });
  if (openReports > 0) throw new AppError(409, "A program with open reports cannot be deleted");

  await prisma.program.update({ where: { id }, data: { deletedAt: new Date() } });
}
