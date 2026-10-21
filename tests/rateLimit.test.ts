// Must stay first: it switches limiting on before the app reads its config.
import "./helpers/enableRateLimit";
import { AUTH_LIMIT, REPORT_SUBMIT_LIMIT } from "../src/shared/constants/rateLimit";
import { API, api, bearer, expectError } from "./helpers/api";
import { createProgram, createUser, purge } from "./helpers/factory";

afterAll(purge);

describe("rate limiting", () => {
  it("blocks login attempts past the per-IP limit with a 429 in the standard envelope", async () => {
    const attempt = () =>
      api()
        .post(`${API}/auth/login`)
        .send({ email: "nobody@example.com", password: "wrong-password" });

    for (let i = 0; i < AUTH_LIMIT.limit; i++) expectError(await attempt(), 401);

    const blocked = await attempt();
    expectError(blocked, 429, { message: /too many requests/i });
    expect(blocked.headers["retry-after"]).toBeDefined();
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("applies the auth limit to every /auth route, sharing one budget per IP", async () => {
    expectError(await api().post(`${API}/auth/register`).send({}), 429);
    expectError(await api().post(`${API}/auth/refresh-token`).send({}), 429);
    expectError(await api().post(`${API}/auth/google`).send({}), 429);
  });

  it("leaves the rest of the API and the health check unaffected", async () => {
    const user = await createUser("RESEARCHER");
    expect((await api().get(`${API}/users/me`).set(bearer(user))).status).toBe(200);
    expect((await api().get("/health")).status).toBe(200);
  });

  it("reports the remaining budget in standard headers", async () => {
    const user = await createUser("RESEARCHER");
    const res = await api().get(`${API}/users/me`).set(bearer(user));
    expect(res.headers["ratelimit-limit"]).toBeDefined();
    expect(res.headers["ratelimit-remaining"]).toBeDefined();
  });

  it("limits report submissions per user, not per IP", async () => {
    const owner = await createUser("PROGRAM_OWNER");
    const program = await createProgram(owner, { status: "ACTIVE" });
    const [first, second] = await Promise.all([createUser("RESEARCHER"), createUser("RESEARCHER")]);
    const submit = (u: { token: string }, n: number) =>
      api()
        .post(`${API}/reports`)
        .set(bearer(u))
        .send({
          programId: program.id,
          title: `Rate limited report ${n}`,
          description: "Long enough description for validation.",
        });

    for (let i = 0; i < REPORT_SUBMIT_LIMIT.limit; i++)
      expect((await submit(first, i)).status).toBe(201);
    expectError(await submit(first, 99), 429);

    // A different researcher on the same IP still has a full budget.
    expect((await submit(second, 1)).status).toBe(201);
    // The blocked researcher can still read.
    expect((await api().get(`${API}/reports`).set(bearer(first))).status).toBe(200);
  });

  it("does not rate limit the Stripe webhook", async () => {
    // Far more requests than the global limit would allow in one window would be slow,
    // so this checks the skip rule directly: the webhook path is exempt by prefix.
    const res = await api()
      .post(`${API}/payments/webhook`)
      .set("Content-Type", "application/json")
      .send("{}");
    expect(res.status).toBe(400);
    expect(res.headers["ratelimit-limit"]).toBeUndefined();
  });
});

// These rely on the first test above having spent the default IP's auth budget.
describe("visitor IP from the frontend server", () => {
  const secret = process.env.BFF_SHARED_SECRET as string;
  const login = (headers: Record<string, string>) =>
    api()
      .post(`${API}/auth/login`)
      .set(headers)
      .send({ email: "nobody@example.com", password: "wrong-password" });

  it("keys the limit on X-Client-IP when the secret matches", async () => {
    expectError(await login({}), 429);
    expectError(await login({ "X-BFF-Secret": secret, "X-Client-IP": "203.0.113.7" }), 401);
  });

  it("ignores X-Client-IP without the right secret", async () => {
    expectError(await login({ "X-Client-IP": "203.0.113.8" }), 429);
    expectError(await login({ "X-BFF-Secret": "wrong", "X-Client-IP": "203.0.113.8" }), 429);
  });

  it("ignores a malformed X-Client-IP", async () => {
    expectError(await login({ "X-BFF-Secret": secret, "X-Client-IP": "not-an-ip" }), 429);
  });

  it("gives each visitor a separate budget", async () => {
    const visitor = { "X-BFF-Secret": secret, "X-Client-IP": "203.0.113.20" };
    for (let i = 0; i < AUTH_LIMIT.limit; i++) expectError(await login(visitor), 401);
    expectError(await login(visitor), 429);
    expectError(await login({ ...visitor, "X-Client-IP": "203.0.113.21" }), 401);
  });
});
