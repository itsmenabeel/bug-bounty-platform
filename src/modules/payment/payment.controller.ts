import { catchAsync } from "../../shared/utils/catchAsync";
import { requireUser } from "../../shared/utils/requireUser";
import { sendResponse } from "../../shared/utils/sendResponse";
import * as paymentService from "./payment.service";
import type { ListPaymentsQuery } from "./payment.validation";

export const createCheckout = catchAsync(async (req, res) => {
  const data = await paymentService.createCheckoutSession(requireUser(req).id, req.body);
  sendResponse(res, { statusCode: 201, message: "Checkout session created", data });
});

export const webhook = catchAsync(async (req, res) => {
  await paymentService.handleStripeEvent(req.body, req.header("stripe-signature"));
  sendResponse(res, { message: "Webhook received" });
});

export const list = catchAsync(async (req, res) => {
  const { items, meta } = await paymentService.listPayments(
    requireUser(req),
    req.query as unknown as ListPaymentsQuery,
  );
  sendResponse(res, { message: "Payments retrieved", data: items, meta });
});

export const getOne = catchAsync(async (req, res) => {
  const data = await paymentService.getPayment(String(req.params.id), requireUser(req));
  sendResponse(res, { message: "Payment retrieved", data });
});

export const verify = catchAsync(async (req, res) => {
  const data = await paymentService.verifyPayment(String(req.params.id), requireUser(req));
  sendResponse(res, { message: "Payment status refreshed", data });
});
