import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import { idParamSchema } from "../../shared/utils/commonSchemas";
import * as reportController from "./report.controller";
import { createReportSchema, listReportsSchema, updateReportSchema } from "./report.validation";

export const reportRoutes = Router();

reportRoutes.use(authenticate);

reportRoutes.post(
  "/",
  authorize(ROLES.RESEARCHER),
  validate(createReportSchema),
  reportController.create,
);
reportRoutes.get("/", validate(listReportsSchema), reportController.list);
reportRoutes.get("/:id", validate(idParamSchema), reportController.getOne);
reportRoutes.patch(
  "/:id",
  authorize(ROLES.RESEARCHER),
  validate(updateReportSchema),
  reportController.update,
);
reportRoutes.delete(
  "/:id",
  authorize(ROLES.RESEARCHER),
  validate(idParamSchema),
  reportController.remove,
);
