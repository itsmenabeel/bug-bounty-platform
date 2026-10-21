import { Router } from "express";
import { validate } from "../../middlewares/validate";
import { idParamSchema } from "../../shared/utils/commonSchemas";
import * as publicController from "./public.controller";
import { listPublicProgramsSchema } from "./public.validation";

// No authenticate here: these routes serve signed-out visitors.
export const publicRoutes = Router();

publicRoutes.get("/programs", validate(listPublicProgramsSchema), publicController.listPrograms);
publicRoutes.get("/programs/:id", validate(idParamSchema), publicController.getProgram);
publicRoutes.get("/stats", publicController.stats);
