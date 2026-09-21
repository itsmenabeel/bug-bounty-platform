import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as programService from "./program.service";

export const create = catchAsync(async (req, res) => {
  const data = await programService.createProgram(requireUser(req).id, req.body);
  sendResponse(res, { statusCode: 201, message: "Program created", data });
});

export const getOne = catchAsync(async (req, res) => {
  const data = await programService.getProgram(String(req.params.id), requireUser(req));
  sendResponse(res, { message: "Program retrieved", data });
});

export const update = catchAsync(async (req, res) => {
  const data = await programService.updateProgram(
    String(req.params.id),
    requireUser(req).id,
    req.body,
  );
  sendResponse(res, { message: "Program updated", data });
});

export const remove = catchAsync(async (req, res) => {
  await programService.deleteProgram(String(req.params.id), requireUser(req).id);
  sendResponse(res, { message: "Program deleted" });
});
