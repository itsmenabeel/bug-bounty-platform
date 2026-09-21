import type { Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { programSelect } from "./program.select";
import type { CreateProgramInput, UpdateProgramInput } from "./program.validation";

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
