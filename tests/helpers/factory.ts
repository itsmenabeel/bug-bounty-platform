import type { ProgramStatus, ReportStatus, Role, Severity } from "@prisma/client";
import bcrypt from "bcrypt";
import { prisma } from "../../src/config/prisma";
import { signAccessToken } from "../../src/shared/utils/jwt";

// Every row a test file creates carries this tag, so purge() removes only its own data.
export const TAG = `jt${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export const PASSWORD = "Passw0rdX";

let counter = 0;
let passwordHash: string | undefined;

export const uniqueEmail = (label = "u") => `${TAG}.${label}${++counter}@example.com`;

export async function createUser(role: Role = "RESEARCHER", data: Record<string, unknown> = {}) {
  // Low cost keeps setup fast. bcrypt verifies any cost, so login tests still work.
  passwordHash ??= await bcrypt.hash(PASSWORD, 4);
  const user = await prisma.user.create({
    data: {
      email: uniqueEmail(role.toLowerCase()),
      name: `Test ${role}`,
      role,
      passwordHash,
      ...data,
    },
  });
  return { ...user, token: signAccessToken({ sub: user.id, role }) };
}
export type TestUser = Awaited<ReturnType<typeof createUser>>;

export const DEFAULT_TIERS: Record<Severity, number> = {
  LOW: 1000,
  MEDIUM: 5000,
  HIGH: 15000,
  CRITICAL: 50000,
};

type ProgramOptions = {
  title?: string;
  status?: ProgramStatus;
  poolBalance?: number;
  tiers?: Partial<Record<Severity, number>> | null;
  description?: string;
};

export function createProgram(owner: { id: string }, options: ProgramOptions = {}) {
  const tiers = options.tiers === undefined ? DEFAULT_TIERS : options.tiers;
  return prisma.program.create({
    data: {
      ownerId: owner.id,
      title: options.title ?? `${TAG} Program ${++counter}`,
      description: options.description ?? "Program created for automated tests.",
      scope: { inScope: ["app.test"], outOfScope: [] },
      status: options.status ?? "ACTIVE",
      poolBalance: options.poolBalance ?? 0,
      rewardTiers: tiers
        ? {
            create: Object.entries(tiers).map(([severity, amount]) => ({
              severity: severity as Severity,
              amount: amount as number,
            })),
          }
        : undefined,
    },
  });
}

type ReportOptions = { title?: string; status?: ReportStatus; severity?: Severity | null };

export function createReport(
  program: { id: string },
  researcher: { id: string },
  options: ReportOptions = {},
) {
  return prisma.report.create({
    data: {
      programId: program.id,
      researcherId: researcher.id,
      title: options.title ?? `${TAG} Report ${++counter}`,
      description: "Report created for automated tests, long enough to validate.",
      status: options.status ?? "NEW",
      severity: options.severity ?? null,
    },
  });
}

/** Deletes every row belonging to users created with this file's TAG, children first. */
export async function purge() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: `${TAG}.` } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  if (userIds.length === 0) return;

  const programs = await prisma.program.findMany({
    where: { ownerId: { in: userIds } },
    select: { id: true },
  });
  const programIds = programs.map((program) => program.id);

  const reports = await prisma.report.findMany({
    where: { OR: [{ researcherId: { in: userIds } }, { programId: { in: programIds } }] },
    select: { id: true },
  });
  const reportIds = reports.map((report) => report.id);

  await prisma.payout.deleteMany({
    where: {
      OR: [
        { reportId: { in: reportIds } },
        { researcherId: { in: userIds } },
        { programId: { in: programIds } },
      ],
    },
  });
  await prisma.reportComment.deleteMany({
    where: { OR: [{ reportId: { in: reportIds } }, { authorId: { in: userIds } }] },
  });
  await prisma.report.updateMany({
    where: { id: { in: reportIds } },
    data: { duplicateOfId: null },
  });
  await prisma.report.deleteMany({ where: { id: { in: reportIds } } });
  await prisma.payment.deleteMany({ where: { programId: { in: programIds } } });
  await prisma.rewardTier.deleteMany({ where: { programId: { in: programIds } } });
  await prisma.program.deleteMany({ where: { id: { in: programIds } } });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { actorId: { in: userIds } },
        { entityId: { in: [...userIds, ...programIds, ...reportIds] } },
      ],
    },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
