import { catchAsync } from "../../shared/utils/catchAsync";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as programService from "../program/program.service";
import * as publicService from "./public.service";
import type { ListPublicProgramsQuery } from "./public.validation";

export const listPrograms = catchAsync(async (req, res) => {
  const { items, meta, cache } = await programService.listPublicPrograms(
    req.query as unknown as ListPublicProgramsQuery,
  );
  res.setHeader("X-Cache", cache);
  sendResponse(res, { message: "Programs retrieved", data: items, meta });
});

export const getProgram = catchAsync(async (req, res) => {
  const data = await programService.getPublicProgram(String(req.params.id));
  sendResponse(res, { message: "Program retrieved", data });
});

export const stats = catchAsync(async (_req, res) => {
  const data = await publicService.getPublicStats();
  sendResponse(res, { message: "Platform statistics retrieved", data });
});
