import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import * as adminController from "./admin.controller";
import { listAuditLogsSchema } from "./admin.validation";

export const adminRoutes = Router();

adminRoutes.use(authenticate, authorize(ROLES.ADMIN));

adminRoutes.get("/audit-logs", validate(listAuditLogsSchema), adminController.listAuditLogs);
