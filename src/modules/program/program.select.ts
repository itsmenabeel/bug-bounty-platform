export const programSelect = {
  id: true,
  ownerId: true,
  title: true,
  description: true,
  scope: true,
  status: true,
  poolBalance: true,
  createdAt: true,
  updatedAt: true,
  rewardTiers: { select: { severity: true, amount: true }, orderBy: { amount: "asc" } },
} as const;
