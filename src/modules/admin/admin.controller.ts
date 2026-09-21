import { catchAsync } from "../../shared/utils/catchAsync";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as adminService from "./admin.service";
import type { ListAuditLogsQuery } from "./admin.validation";

export const listAuditLogs = catchAsync(async (req, res) => {
  const { items, meta } = await adminService.listAuditLogs(
    req.query as unknown as ListAuditLogsQuery,
  );
  sendResponse(res, { message: "Audit logs retrieved", data: items, meta });
});
