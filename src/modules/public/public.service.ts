import { prisma } from "../../config/prisma";
import {
  PUBLIC_STATS_CACHE_NAMESPACE,
  PUBLIC_STATS_TTL_SECONDS,
} from "../../shared/constants/cache";
import { cached } from "../../shared/utils/cache";

// Reports that reached a triage decision.
const RESOLVED_STATUSES = ["ACCEPTED", "REWARDED", "REJECTED", "DUPLICATE"] as const;

export async function getPublicStats() {
  const { value } = await cached(
    PUBLIC_STATS_CACHE_NAMESPACE,
    "stats",
    PUBLIC_STATS_TTL_SECONDS,
    async () => {
      const live = { deletedAt: null };
      const [activePrograms, pools, payouts, reportsResolved, researchers] =
        await prisma.$transaction([
          prisma.program.count({ where: { ...live, status: "ACTIVE" } }),
          prisma.program.aggregate({
            where: { ...live, status: "ACTIVE" },
            _sum: { poolBalance: true },
          }),
          prisma.payout.aggregate({
            where: { status: "PAID" },
            _sum: { amount: true },
            _count: { _all: true },
          }),
          prisma.report.count({ where: { ...live, status: { in: [...RESOLVED_STATUSES] } } }),
          prisma.user.count({ where: { ...live, isActive: true, role: "RESEARCHER" } }),
        ]);
      return {
        activePrograms,
        availableInPools: pools._sum.poolBalance ?? 0,
        totalPaidOut: payouts._sum.amount ?? 0,
        payoutCount: payouts._count._all,
        reportsResolved,
        researchers,
        generatedAt: new Date().toISOString(),
      };
    },
  );
  return value;
}
