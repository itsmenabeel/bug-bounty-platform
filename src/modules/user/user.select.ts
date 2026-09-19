// Fields safe to return to clients. Never includes passwordHash.
export const publicUserSelect = {
  id: true,
  email: true,
  name: true,
  role: true,
  reputation: true,
  walletBalance: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const;
