import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import * as adminController from "./admin.controller";
import {
  listAuditLogsSchema,
  listUsersSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
} from "./admin.validation";

export const adminRoutes = Router();

adminRoutes.use(authenticate, authorize(ROLES.ADMIN));

adminRoutes.get("/audit-logs", validate(listAuditLogsSchema), adminController.listAuditLogs);
adminRoutes.get("/users", validate(listUsersSchema), adminController.listUsers);
adminRoutes.patch(
  "/users/:id/role",
  validate(updateUserRoleSchema),
  adminController.updateUserRole,
);
adminRoutes.patch(
  "/users/:id/status",
  validate(updateUserStatusSchema),
  adminController.updateUserStatus,
);
adminRoutes.get("/dashboard-stats", adminController.dashboardStats);
