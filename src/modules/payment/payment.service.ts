import type { PaymentStatus, Prisma, Role } from "@prisma/client";
import type Stripe from "stripe";
import { env } from "../../config/env";
import { prisma } from "../../config/prisma";
import { stripe } from "../../config/stripe";
import { PROGRAMS_CACHE_NAMESPACE } from "../../shared/constants/cache";
import { PAYMENT_CURRENCY } from "../../shared/constants/payment";
import { ROLES } from "../../shared/constants/roles";
import { AppError } from "../../shared/errors/AppError";
import { writeAudit } from "../../shared/utils/audit";
import { invalidate } from "../../shared/utils/cache";
import { applyPagination, buildMeta } from "../../shared/utils/pagination";
import type { CreateCheckoutInput, ListPaymentsQuery } from "./payment.validation";

type Actor = { id: string; role: Role };

const paymentSelect = {
  id: true,
  programId: true,
  amount: true,
  currency: true,
  provider: true,
  status: true,
  stripeSessionId: true,
  createdAt: true,
  updatedAt: true,
  program: { select: { id: true, title: true } },
} as const;

// Owners see payments on their programs, admins see all.
const visibleTo = (actor: Actor): Prisma.PaymentWhereInput =>
  actor.role === ROLES.ADMIN ? {} : { program: { ownerId: actor.id } };

const withSessionId = (url: string) =>
  `${url}${url.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`;

export async function createCheckoutSession(ownerId: string, input: CreateCheckoutInput) {
  const program = await prisma.program.findFirst({
    where: { id: input.programId, deletedAt: null },
    select: { id: true, ownerId: true, title: true, status: true },
  });
  if (!program) throw new AppError(404, "Program not found");
  if (program.ownerId !== ownerId) throw new AppError(403, "You do not own this program");
  if (program.status === "CLOSED") throw new AppError(409, "A closed program cannot be funded");

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: PAYMENT_CURRENCY,
            unit_amount: input.amount,
            product_data: { name: `Bounty funding: ${program.title}` },
          },
        },
      ],
      success_url: withSessionId(env.PAYMENT_SUCCESS_URL),
      cancel_url: env.PAYMENT_CANCEL_URL,
      metadata: { programId: program.id, ownerId },
    });
  } catch (error) {
    console.error("Stripe session creation failed:", error);
    throw new AppError(502, "Payment provider is unavailable");
  }
  if (!session.url) throw new AppError(502, "Payment provider returned no checkout URL");

  const payment = await prisma.payment.create({
    data: { programId: program.id, amount: input.amount, stripeSessionId: session.id },
    select: { id: true, programId: true, amount: true, currency: true, status: true },
  });
  return { payment, checkoutUrl: session.url };
}

/** Verifies the Stripe signature against the raw body, then applies the event. */
export async function handleStripeEvent(rawBody: unknown, signature: string | undefined) {
  if (!signature || !Buffer.isBuffer(rawBody)) {
    throw new AppError(400, "Missing Stripe signature or raw body");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, "Invalid Stripe signature");
  }

  const session = event.data.object as Stripe.Checkout.Session;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
      if (session.payment_status === "paid") await creditPool(session);
      break;
    case "checkout.session.async_payment_failed":
      await closePending(session.id, "FAILED");
      break;
    case "checkout.session.expired":
      await closePending(session.id, "CANCELLED");
      break;
  }
}

// Only a PENDING payment can be closed, so duplicate deliveries change nothing.
async function closePending(stripeSessionId: string, status: PaymentStatus) {
  await prisma.payment.updateMany({
    where: { stripeSessionId, status: "PENDING" },
    data: { status },
  });
}

/**
 * Flips the payment PENDING to SUCCEEDED and credits the pool in one transaction.
 * The conditional update lets only the first delivery claim the payment.
 */
async function creditPool(session: Stripe.Checkout.Session) {
  const payment = await prisma.payment.findUnique({
    where: { stripeSessionId: session.id },
    select: { id: true, programId: true, amount: true, program: { select: { ownerId: true } } },
  });
  if (!payment) {
    console.warn(`Stripe session ${session.id} has no matching payment; ignored`);
    return;
  }

  if (session.amount_total !== payment.amount) {
    console.error(`Amount mismatch for payment ${payment.id}; not credited`);
    await closePending(session.id, "FAILED");
    return;
  }

  const credited = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "SUCCEEDED" },
    });
    if (claimed.count === 0) return false;

    await tx.program.update({
      where: { id: payment.programId },
      data: { poolBalance: { increment: payment.amount } },
    });
    await writeAudit(tx, {
      actorId: payment.program.ownerId,
      action: "POOL_FUNDED",
      entityType: "Program",
      entityId: payment.programId,
      metadata: { paymentId: payment.id, amount: payment.amount, stripeSessionId: session.id },
    });
    return true;
  });

  // The listing shows poolBalance, so funding makes cached lists stale.
  if (credited) await invalidate(PROGRAMS_CACHE_NAMESPACE);
}

export async function listPayments(actor: Actor, query: ListPaymentsQuery) {
  const where: Prisma.PaymentWhereInput = {
    ...visibleTo(actor),
    ...(query.status && { status: query.status }),
    ...(query.programId && { programId: query.programId }),
    ...(query.sessionId && { stripeSessionId: query.sessionId }),
  };

  const [total, items] = await prisma.$transaction([
    prisma.payment.count({ where }),
    prisma.payment.findMany({ where, select: paymentSelect, ...applyPagination(query) }),
  ]);
  return { items, meta: buildMeta(query.page, query.limit, total) };
}

export async function getPayment(id: string, actor: Actor) {
  const payment = await prisma.payment.findFirst({
    where: { id, ...visibleTo(actor) },
    select: paymentSelect,
  });
  if (!payment) throw new AppError(404, "Payment not found");
  return payment;
}

/**
 * Asks Stripe for the session state and applies it. Covers a webhook that never
 * arrived, and shares the webhook's idempotent handlers so both paths agree.
 */
export async function verifyPayment(id: string, actor: Actor) {
  const payment = await getPayment(id, actor);
  if (payment.status !== "PENDING") return payment;

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(payment.stripeSessionId);
  } catch (error) {
    console.error("Stripe session lookup failed:", error);
    throw new AppError(502, "Payment provider is unavailable");
  }

  if (session.payment_status === "paid") await creditPool(session);
  else if (session.status === "expired") await closePending(session.id, "CANCELLED");

  return getPayment(id, actor);
}
