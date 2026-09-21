import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import { idParamSchema } from "../../shared/utils/commonSchemas";
import * as paymentController from "./payment.controller";
import { createCheckoutSchema, listPaymentsSchema } from "./payment.validation";

export const paymentRoutes = Router();

// Called by Stripe, so it has no bearer token. The signature is the credential.
paymentRoutes.post("/webhook", paymentController.webhook);

paymentRoutes.post(
  "/checkout",
  authenticate,
  authorize(ROLES.PROGRAM_OWNER),
  validate(createCheckoutSchema),
  paymentController.createCheckout,
);

paymentRoutes.use(authenticate, authorize(ROLES.PROGRAM_OWNER, ROLES.ADMIN));

paymentRoutes.get("/", validate(listPaymentsSchema), paymentController.list);
paymentRoutes.get("/:id", validate(idParamSchema), paymentController.getOne);
paymentRoutes.post("/:id/verify", validate(idParamSchema), paymentController.verify);
