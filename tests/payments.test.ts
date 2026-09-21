import { prisma } from "../src/config/prisma";
import { stripe } from "../src/config/stripe";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createUser, purge } from "./helpers/factory";
import { checkoutSession, mockSessionCreate, signedWebhook } from "./helpers/stripe";

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let otherOwner: User;
let researcher: User;
let admin: User;
let createSpy: ReturnType<typeof mockSessionCreate>;

beforeAll(async () => {
  [owner, otherOwner, researcher, admin] = await Promise.all([
    createUser("PROGRAM_OWNER"),
    createUser("PROGRAM_OWNER"),
    createUser("RESEARCHER"),
    createUser("ADMIN"),
  ]);
  createSpy = mockSessionCreate();
});
afterAll(async () => {
  jest.restoreAllMocks();
  await purge();
});

const checkout = (u: User, body: Record<string, unknown>) =>
  api().post(`${API}/payments/checkout`).set(bearer(u)).send(body);
const poolOf = async (id: string) =>
  (await prisma.program.findUniqueOrThrow({ where: { id } })).poolBalance;
const sendHook = (payload: string, header?: string) => {
  const req = api().post(`${API}/payments/webhook`).set("Content-Type", "application/json");
  if (header) req.set("stripe-signature", header);
  return req.send(payload);
};
const deliver = (type: string, object: Record<string, unknown>) => {
  const { payload, header } = signedWebhook(type, object);
  return sendHook(payload, header);
};

/** Starts a funding checkout and returns the payment row and its Stripe session id. */
async function startFunding(program: { id: string }, amount: number, who: User = owner) {
  const res = await checkout(who, { programId: program.id, amount });
  expect(res.status).toBe(201);
  const payment = await prisma.payment.findUniqueOrThrow({
    where: { id: res.body.data.payment.id },
  });
  return { payment, sessionId: payment.stripeSessionId, res };
}

describe("POST /payments/checkout", () => {
  it("creates a Stripe session and a pending payment, without touching the pool", async () => {
    const program = await createProgram(owner, { status: "DRAFT", tiers: null });
    const { res, payment } = await startFunding(program, 5_000);

    expect(res.body.data.checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(res.body.data.payment).toMatchObject({
      programId: program.id,
      amount: 5_000,
      currency: "usd",
      status: "PENDING",
    });
    expect(payment.stripeSessionId).toMatch(/^cs_test_/);
    expect(await poolOf(program.id)).toBe(0);
  });

  it("sends Stripe the amount in cents, the currency, metadata and redirect URLs", async () => {
    const program = await createProgram(owner);
    createSpy.mockClear();
    await startFunding(program, 12_345);

    const params = createSpy.mock.calls[0][0] as any;
    expect(params.mode).toBe("payment");
    expect(params.line_items[0]).toMatchObject({
      quantity: 1,
      price_data: { currency: "usd", unit_amount: 12_345 },
    });
    expect(params.metadata).toEqual({ programId: program.id, ownerId: owner.id });
    expect(params.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
    expect(params.cancel_url).toBe(process.env.PAYMENT_CANCEL_URL);
  });

  it("is limited to program owners, and only for their own program", async () => {
    const program = await createProgram(owner);
    expectError(await checkout(researcher, { programId: program.id, amount: 5_000 }), 403);
    expectError(await checkout(admin, { programId: program.id, amount: 5_000 }), 403);
    expectError(await checkout(otherOwner, { programId: program.id, amount: 5_000 }), 403);
    expectError(await api().post(`${API}/payments/checkout`).send({}), 401);
  });

  it("refuses closed and unknown programs", async () => {
    const closed = await createProgram(owner, { status: "CLOSED" });
    expectError(await checkout(owner, { programId: closed.id, amount: 5_000 }), 409);
    expectError(await checkout(owner, { programId: NIL_UUID, amount: 5_000 }), 404);
  });

  it.each([
    ["a fractional amount", 10.5],
    ["zero", 0],
    ["a negative amount", -5],
    ["below the minimum", 100],
    ["above the maximum", 999_999_999],
    ["a string", "5000"],
  ])("rejects %s", async (_label, amount) => {
    const program = await createProgram(owner);
    expectError(await checkout(owner, { programId: program.id, amount }), 422);
  });

  it("rejects extra fields, such as a client-chosen currency", async () => {
    const program = await createProgram(owner);
    expectError(
      await checkout(owner, { programId: program.id, amount: 5_000, currency: "eur" }),
      422,
    );
  });

  it("returns 502 and stores nothing when Stripe fails", async () => {
    const program = await createProgram(owner);
    jest.spyOn(console, "error").mockImplementation(() => {});
    createSpy.mockRejectedValueOnce(new Error("stripe is down"));

    expectError(await checkout(owner, { programId: program.id, amount: 5_000 }), 502, {
      message: /unavailable/i,
    });
    expect(await prisma.payment.count({ where: { programId: program.id } })).toBe(0);
  });
});

describe("POST /payments/webhook", () => {
  it("credits the pool and marks the payment SUCCEEDED for a valid signed event", async () => {
    const program = await createProgram(owner);
    const { payment, sessionId } = await startFunding(program, 7_500);

    const res = await deliver("checkout.session.completed", checkoutSession(sessionId, 7_500));
    expect(res.status).toBe(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "SUCCEEDED",
    );
    expect(await poolOf(program.id)).toBe(7_500);

    const audit = await prisma.auditLog.findMany({
      where: { entityId: program.id, action: "POOL_FUNDED" },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({
      paymentId: payment.id,
      amount: 7_500,
      stripeSessionId: sessionId,
    });
  });

  it("credits only once when Stripe redelivers the same event", async () => {
    const program = await createProgram(owner);
    const { sessionId } = await startFunding(program, 4_000);
    const { payload, header } = signedWebhook(
      "checkout.session.completed",
      checkoutSession(sessionId, 4_000),
    );

    for (let i = 0; i < 3; i++) expect((await sendHook(payload, header)).status).toBe(200);
    expect(await poolOf(program.id)).toBe(4_000);
    expect(
      await prisma.auditLog.count({ where: { entityId: program.id, action: "POOL_FUNDED" } }),
    ).toBe(1);
  });

  it("credits once when eight deliveries arrive simultaneously", async () => {
    const program = await createProgram(owner);
    const { sessionId, payment } = await startFunding(program, 2_000);
    const { payload, header } = signedWebhook(
      "checkout.session.completed",
      checkoutSession(sessionId, 2_000),
    );

    const results = await Promise.all(Array.from({ length: 8 }, () => sendHook(payload, header)));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await poolOf(program.id)).toBe(2_000);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
      "SUCCEEDED",
    );
  });

  it("adds up separate payments to the same program", async () => {
    const program = await createProgram(owner);
    const a = await startFunding(program, 1_000);
    const b = await startFunding(program, 3_000);
    await deliver("checkout.session.completed", checkoutSession(a.sessionId, 1_000));
    await deliver("checkout.session.completed", checkoutSession(b.sessionId, 3_000));
    expect(await poolOf(program.id)).toBe(4_000);
  });

  describe("signature verification", () => {
    it("rejects a request with no signature header", async () => {
      expectError(await sendHook("{}"), 400);
    });

    it("rejects a signature made with the wrong secret", async () => {
      const program = await createProgram(owner);
      const { sessionId } = await startFunding(program, 5_000);
      const { payload, header } = signedWebhook(
        "checkout.session.completed",
        checkoutSession(sessionId, 5_000),
        "whsec_attacker",
      );
      expectError(await sendHook(payload, header), 400, { message: /signature/i });
      expect(await poolOf(program.id)).toBe(0);
    });

    it("rejects a body changed after signing", async () => {
      const program = await createProgram(owner);
      const { sessionId } = await startFunding(program, 5_000);
      const { payload, header } = signedWebhook(
        "checkout.session.completed",
        checkoutSession(sessionId, 5_000),
      );
      expectError(await sendHook(payload.replace("5000", "50000"), header), 400);
      expect(await poolOf(program.id)).toBe(0);
    });

    it("rejects a stale timestamp", async () => {
      const program = await createProgram(owner);
      const { sessionId } = await startFunding(program, 5_000);
      const payload = JSON.stringify({
        id: "evt_old",
        object: "event",
        type: "checkout.session.completed",
        data: { object: checkoutSession(sessionId, 5_000) },
      });
      const header = stripe.webhooks.generateTestHeaderString({
        payload,
        secret: process.env.STRIPE_WEBHOOK_SECRET as string,
        timestamp: Math.floor(Date.now() / 1000) - 3_600,
      });
      expectError(await sendHook(payload, header), 400);
      expect(await poolOf(program.id)).toBe(0);
    });

    it("does not need a bearer token, because the signature is the credential", async () => {
      const { payload, header } = signedWebhook("customer.created", {
        id: "cus_1",
        object: "customer",
      });
      expect((await sendHook(payload, header)).status).toBe(200);
    });
  });

  describe("event handling", () => {
    it("ignores a completed session that is not yet paid", async () => {
      const program = await createProgram(owner);
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver(
        "checkout.session.completed",
        checkoutSession(sessionId, 5_000, { payment_status: "unpaid" }),
      );
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "PENDING",
      );
      expect(await poolOf(program.id)).toBe(0);
    });

    it("credits when an asynchronous payment later succeeds", async () => {
      const program = await createProgram(owner);
      const { sessionId } = await startFunding(program, 6_000);
      await deliver("checkout.session.async_payment_succeeded", checkoutSession(sessionId, 6_000));
      expect(await poolOf(program.id)).toBe(6_000);
    });

    it("marks the payment FAILED, without crediting, when the amount does not match", async () => {
      const program = await createProgram(owner);
      jest.spyOn(console, "error").mockImplementation(() => {});
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver("checkout.session.completed", checkoutSession(sessionId, 1));
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "FAILED",
      );
      expect(await poolOf(program.id)).toBe(0);
    });

    it("acknowledges a session it does not know", async () => {
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const res = await deliver(
        "checkout.session.completed",
        checkoutSession("cs_test_unknown", 100),
      );
      expect(res.status).toBe(200);
    });

    it("cancels a pending payment when the session expires", async () => {
      const program = await createProgram(owner);
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver("checkout.session.expired", { id: sessionId, object: "checkout.session" });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "CANCELLED",
      );
    });

    it("does not credit a payment that was already cancelled", async () => {
      const program = await createProgram(owner);
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver("checkout.session.expired", { id: sessionId, object: "checkout.session" });
      await deliver("checkout.session.completed", checkoutSession(sessionId, 5_000));
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "CANCELLED",
      );
      expect(await poolOf(program.id)).toBe(0);
    });

    it("marks the payment FAILED when an asynchronous payment fails", async () => {
      const program = await createProgram(owner);
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver("checkout.session.async_payment_failed", {
        id: sessionId,
        object: "checkout.session",
      });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "FAILED",
      );
    });

    it("never moves a settled payment backwards", async () => {
      const program = await createProgram(owner);
      const { payment, sessionId } = await startFunding(program, 5_000);
      await deliver("checkout.session.completed", checkoutSession(sessionId, 5_000));
      await deliver("checkout.session.expired", { id: sessionId, object: "checkout.session" });
      await deliver("checkout.session.async_payment_failed", {
        id: sessionId,
        object: "checkout.session",
      });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).status).toBe(
        "SUCCEEDED",
      );
      expect(await poolOf(program.id)).toBe(5_000);
    });
  });
});

describe("payment status endpoints", () => {
  let program: Awaited<ReturnType<typeof createProgram>>;
  let paymentId: string;
  let sessionId: string;

  beforeAll(async () => {
    program = await createProgram(owner);
    const first = await startFunding(program, 1_500);
    await startFunding(program, 2_500);
    await startFunding(program, 3_500);
    paymentId = first.payment.id;
    sessionId = first.sessionId;
  });

  it("shows a payment to its owner and to admins", async () => {
    for (const u of [owner, admin]) {
      const res = await api().get(`${API}/payments/${paymentId}`).set(bearer(u));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: paymentId,
        status: "PENDING",
        amount: 1_500,
        currency: "usd",
        stripeSessionId: sessionId,
      });
      expect(res.body.data.program.id).toBe(program.id);
    }
  });

  it("returns 404 to another owner and 403 to researchers", async () => {
    expectError(await api().get(`${API}/payments/${paymentId}`).set(bearer(otherOwner)), 404);
    expectError(await api().get(`${API}/payments/${paymentId}`).set(bearer(researcher)), 403);
    expectError(await api().get(`${API}/payments/${NIL_UUID}`).set(bearer(owner)), 404);
    expectError(await api().get(`${API}/payments/nope`).set(bearer(owner)), 422);
  });

  it("lists only the caller's payments, sorted and paginated", async () => {
    const list = (u: User, q = "") =>
      api().get(`${API}/payments?programId=${program.id}${q}`).set(bearer(u));
    const sorted = await list(owner, "&sortBy=amount&order=asc&limit=2");
    expect(sorted.body.data.map((p: any) => p.amount)).toEqual([1_500, 2_500]);
    expect(sorted.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    expect((await list(otherOwner)).body.meta.total).toBe(0);
    expect((await list(admin)).body.meta.total).toBe(3);
  });

  it("filters by status and looks a payment up by Stripe session id", async () => {
    const byStatus = await api()
      .get(`${API}/payments?programId=${program.id}&status=SUCCEEDED`)
      .set(bearer(owner));
    expect(byStatus.body.meta.total).toBe(0);
    const bySession = await api().get(`${API}/payments?sessionId=${sessionId}`).set(bearer(owner));
    expect(bySession.body.data.map((p: any) => p.id)).toEqual([paymentId]);
    expectError(await api().get(`${API}/payments?status=NOPE`).set(bearer(owner)), 422);
  });
});

describe("POST /payments/:id/verify", () => {
  const retrieveSpy = () => jest.spyOn(stripe.checkout.sessions, "retrieve");
  afterEach(() => retrieveSpy().mockReset());
  const verify = (id: string, u: User = owner) =>
    api().post(`${API}/payments/${id}/verify`).set(bearer(u));

  it("credits the pool when Stripe reports the session as paid, and only once", async () => {
    const program = await createProgram(owner);
    const { payment, sessionId } = await startFunding(program, 3_000);
    const spy = retrieveSpy().mockResolvedValue(
      checkoutSession(sessionId, 3_000, { status: "complete" }) as never,
    );

    const first = await verify(payment.id);
    expect(first.status).toBe(200);
    expect(first.body.data.status).toBe("SUCCEEDED");
    expect(await poolOf(program.id)).toBe(3_000);

    await verify(payment.id);
    expect(await poolOf(program.id)).toBe(3_000);
    // Settled payments are answered from the database, without another Stripe call.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("leaves an unpaid session pending", async () => {
    const program = await createProgram(owner);
    const { payment, sessionId } = await startFunding(program, 3_000);
    retrieveSpy().mockResolvedValue(
      checkoutSession(sessionId, 3_000, { payment_status: "unpaid", status: "open" }) as never,
    );
    expect((await verify(payment.id)).body.data.status).toBe("PENDING");
    expect(await poolOf(program.id)).toBe(0);
  });

  it("cancels the payment when Stripe says the session expired", async () => {
    const program = await createProgram(owner);
    const { payment, sessionId } = await startFunding(program, 3_000);
    retrieveSpy().mockResolvedValue(
      checkoutSession(sessionId, 3_000, { payment_status: "unpaid", status: "expired" }) as never,
    );
    expect((await verify(payment.id)).body.data.status).toBe("CANCELLED");
  });

  it("agrees with the webhook, so running both credits once", async () => {
    const program = await createProgram(owner);
    const { payment, sessionId } = await startFunding(program, 3_000);
    retrieveSpy().mockResolvedValue(
      checkoutSession(sessionId, 3_000, { status: "complete" }) as never,
    );
    await Promise.all([
      verify(payment.id),
      deliver("checkout.session.completed", checkoutSession(sessionId, 3_000)),
    ]);
    expect(await poolOf(program.id)).toBe(3_000);
  });

  it("returns 502 when Stripe cannot be reached", async () => {
    const program = await createProgram(owner);
    const { payment } = await startFunding(program, 3_000);
    jest.spyOn(console, "error").mockImplementation(() => {});
    retrieveSpy().mockRejectedValue(new Error("network"));
    expectError(await verify(payment.id), 502);
  });

  it("is limited to the payment's owner or an admin", async () => {
    const program = await createProgram(owner);
    const { payment } = await startFunding(program, 3_000);
    expectError(await verify(payment.id, otherOwner), 404);
    expectError(await verify(payment.id, researcher), 403);
    expectError(await verify(NIL_UUID), 404);
  });
});
