import { Router } from "express";
import { authenticate } from "../../middlewares/authenticate";
import { authorize } from "../../middlewares/authorize";
import { validate } from "../../middlewares/validate";
import { ROLES } from "../../shared/constants/roles";
import * as paymentController from "./payment.controller";
import { createCheckoutSchema } from "./payment.validation";

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
