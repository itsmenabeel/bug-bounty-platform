import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as paymentService from "./payment.service";

export const createCheckout = catchAsync(async (req, res) => {
  const data = await paymentService.createCheckoutSession(requireUser(req).id, req.body);
  sendResponse(res, { statusCode: 201, message: "Checkout session created", data });
});

export const webhook = catchAsync(async (req, res) => {
  await paymentService.handleStripeEvent(req.body, req.header("stripe-signature"));
  sendResponse(res, { message: "Webhook received" });
});
