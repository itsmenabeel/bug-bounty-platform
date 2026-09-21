import { randomBytes } from "node:crypto";
import { env } from "../../src/config/env";
import { stripe } from "../../src/config/stripe";

/** Builds a webhook body and the signature header Stripe would send for it. */
export function signedWebhook(type: string, object: Record<string, unknown>, secret?: string) {
  const payload = JSON.stringify({
    id: `evt_${randomBytes(6).toString("hex")}`,
    object: "event",
    type,
    data: { object },
  });
  const header = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: secret ?? env.STRIPE_WEBHOOK_SECRET,
  });
  return { payload, header };
}

export const checkoutSession = (
  id: string,
  amount: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  object: "checkout.session",
  payment_status: "paid",
  amount_total: amount,
  currency: "usd",
  ...extra,
});

/** Replaces Stripe's session creation, so no test reaches the real API. */
export function mockSessionCreate() {
  return jest.spyOn(stripe.checkout.sessions, "create").mockImplementation((async (params: {
    line_items: { price_data: { unit_amount: number } }[];
  }) => {
    const id = `cs_test_${randomBytes(8).toString("hex")}`;
    return {
      id,
      url: `https://checkout.stripe.com/c/pay/${id}`,
      amount_total: params.line_items[0].price_data.unit_amount,
    };
  }) as never);
}
