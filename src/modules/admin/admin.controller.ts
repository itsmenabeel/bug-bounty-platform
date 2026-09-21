import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as adminService from "./admin.service";
import type { ListAuditLogsQuery, ListUsersQuery } from "./admin.validation";

export const listAuditLogs = catchAsync(async (req, res) => {
  const { items, meta } = await adminService.listAuditLogs(
    req.query as unknown as ListAuditLogsQuery,
  );
  sendResponse(res, { message: "Audit logs retrieved", data: items, meta });
});

export const listUsers = catchAsync(async (req, res) => {
  const { items, meta } = await adminService.listUsers(req.query as unknown as ListUsersQuery);
  sendResponse(res, { message: "Users retrieved", data: items, meta });
});

export const updateUserRole = catchAsync(async (req, res) => {
  const data = await adminService.updateUserRole(requireUser(req), String(req.params.id), req.body);
  sendResponse(res, { message: "User role updated", data });
});

export const updateUserStatus = catchAsync(async (req, res) => {
  const data = await adminService.updateUserStatus(
    requireUser(req),
    String(req.params.id),
    req.body,
  );
  sendResponse(res, { message: "User status updated", data });
});

export const dashboardStats = catchAsync(async (_req, res) => {
  const data = await adminService.getDashboardStats();
  sendResponse(res, { message: "Dashboard statistics retrieved", data });
});
