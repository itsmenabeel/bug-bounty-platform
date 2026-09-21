import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { validate } from "../../middlewares/validate";
import * as payoutController from "./payout.controller";
import { listPayoutsSchema } from "./payout.validation";

export const payoutRoutes = Router();

payoutRoutes.use(authenticate);

payoutRoutes.get("/", validate(listPayoutsSchema), payoutController.list);
