import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import { idParamSchema } from "../../shared/utils/commonSchemas";
import * as programController from "./program.controller";
import { createProgramSchema, updateProgramSchema } from "./program.validation";

export const programRoutes = Router();

programRoutes.use(authenticate);

programRoutes.post(
  "/",
  authorize(ROLES.PROGRAM_OWNER),
  validate(createProgramSchema),
  programController.create,
);
programRoutes.get("/:id", validate(idParamSchema), programController.getOne);
programRoutes.patch(
  "/:id",
  authorize(ROLES.PROGRAM_OWNER),
  validate(updateProgramSchema),
  programController.update,
);
programRoutes.delete(
  "/:id",
  authorize(ROLES.PROGRAM_OWNER),
  validate(idParamSchema),
  programController.remove,
);
