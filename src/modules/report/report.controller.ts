import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as reportService from "./report.service";
import type { ListReportsQuery } from "./report.validation";

export const create = catchAsync(async (req, res) => {
  const data = await reportService.createReport(requireUser(req).id, req.body);
  sendResponse(res, { statusCode: 201, message: "Report submitted", data });
});

export const list = catchAsync(async (req, res) => {
  const { items, meta } = await reportService.listReports(
    requireUser(req),
    req.query as unknown as ListReportsQuery,
  );
  sendResponse(res, { message: "Reports retrieved", data: items, meta });
});

export const getOne = catchAsync(async (req, res) => {
  const data = await reportService.getReport(String(req.params.id), requireUser(req));
  sendResponse(res, { message: "Report retrieved", data });
});

export const update = catchAsync(async (req, res) => {
  const data = await reportService.updateReport(
    String(req.params.id),
    requireUser(req).id,
    req.body,
  );
  sendResponse(res, { message: "Report updated", data });
});

export const remove = catchAsync(async (req, res) => {
  await reportService.deleteReport(String(req.params.id), requireUser(req).id);
  sendResponse(res, { message: "Report deleted" });
});
