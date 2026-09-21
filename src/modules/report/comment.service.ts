import type { Role } from "@prisma/client";
import { prisma } from "../../config/prisma";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import type { CreateCommentInput, ListCommentsQuery } from "./comment.validation";
import { getReport } from "./report.service";

type Actor = { id: string; role: Role };

const commentSelect = {
  id: true,
  reportId: true,
  body: true,
  createdAt: true,
  author: { select: { id: true, name: true, role: true } },
} as const;

// getReport applies the visibility rules, so anyone who can see a report can discuss it.
export async function addComment(reportId: string, actor: Actor, input: CreateCommentInput) {
  await getReport(reportId, actor);
  return prisma.reportComment.create({
    data: { reportId, authorId: actor.id, body: input.body },
    select: commentSelect,
  });
}

export async function listComments(reportId: string, actor: Actor, query: ListCommentsQuery) {
  await getReport(reportId, actor);

  const where = { reportId };
  const [total, items] = await prisma.$transaction([
    prisma.reportComment.count({ where }),
    prisma.reportComment.findMany({ where, select: commentSelect, ...applyPagination(query) }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}
