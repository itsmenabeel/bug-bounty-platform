export const reportSelect = {
  id: true,
  programId: true,
  researcherId: true,
  title: true,
  description: true,
  severity: true,
  status: true,
  duplicateOfId: true,
  createdAt: true,
  updatedAt: true,
  program: { select: { id: true, title: true } },
  researcher: { select: { id: true, name: true, reputation: true } },
} as const;
