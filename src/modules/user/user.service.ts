import { prisma } from "../../config/prisma";
import { AppError } from "../../shared/errors/AppError";
import { publicUserSelect } from "./user.select";
import type { UpdateProfileInput } from "./user.validation";

export async function getProfile(userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: publicUserSelect,
  });
  if (!user) throw new AppError(404, "User not found");
  return user;
}

export async function updateProfile(userId: string, input: UpdateProfileInput) {
  return prisma.user.update({
    where: { id: userId },
    data: { name: input.name },
    select: publicUserSelect,
  });
}
