import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as commentService from "./comment.service";
import type { ListCommentsQuery } from "./comment.validation";

export const create = catchAsync(async (req, res) => {
  const data = await commentService.addComment(String(req.params.id), requireUser(req), req.body);
  sendResponse(res, { statusCode: 201, message: "Comment added", data });
});

export const list = catchAsync(async (req, res) => {
  const { items, meta } = await commentService.listComments(
    String(req.params.id),
    requireUser(req),
    req.query as unknown as ListCommentsQuery,
  );
  sendResponse(res, { message: "Comments retrieved", data: items, meta });
});
