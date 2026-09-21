import { googleClient } from "../src/config/google";
import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError } from "./helpers/api";
import { createUser, PASSWORD, purge, uniqueEmail } from "./helpers/factory";

afterAll(purge);

const register = (body: Record<string, unknown>) => api().post(`${API}/auth/register`).send(body);
const login = (email: string, password = PASSWORD) =>
  api().post(`${API}/auth/login`).send({ email, password });
const refresh = (refreshToken: string) =>
  api().post(`${API}/auth/refresh-token`).send({ refreshToken });

describe("POST /auth/register", () => {
  it("creates a researcher by default and returns tokens without the password hash", async () => {
    const email = uniqueEmail("reg").toUpperCase();
    const res = await register({ email, password: PASSWORD, name: "New Person" });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user).toMatchObject({
      email: email.toLowerCase(),
      role: "RESEARCHER",
      walletBalance: 0,
      reputation: 0,
      isActive: true,
    });
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.refreshToken).toEqual(expect.any(String));
  });

  it("stores a bcrypt hash, never the password", async () => {
    const email = uniqueEmail("hash");
    await register({ email, password: PASSWORD, name: "Hash Check" });
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(stored.passwordHash).not.toContain(PASSWORD);
  });

  it("lets a user register as a program owner", async () => {
    const res = await register({
      email: uniqueEmail("own"),
      password: PASSWORD,
      name: "Owner Person",
      role: "PROGRAM_OWNER",
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe("PROGRAM_OWNER");
  });

  it("does not let a user self-register as an admin", async () => {
    const res = await register({
      email: uniqueEmail("adm"),
      password: PASSWORD,
      name: "Sneaky",
      role: "ADMIN",
    });
    expectError(res, 422);
  });

  it("rejects a duplicate email regardless of case", async () => {
    const email = uniqueEmail("dup");
    await register({ email, password: PASSWORD, name: "First" });
    expectError(
      await register({ email: email.toUpperCase(), password: PASSWORD, name: "Second" }),
      409,
      { message: /already registered/i },
    );
  });

  it("lets only one of several simultaneous registrations succeed", async () => {
    const email = uniqueEmail("race");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => register({ email, password: PASSWORD, name: "Racer" })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it.each([
    ["invalid email", { email: "not-an-email" }, "body.email"],
    ["email over 254 characters", { email: `${"a".repeat(250)}@example.com` }, "body.email"],
    ["password under 8 characters", { password: "Ab1" }, "body.password"],
    ["password without a number", { password: "OnlyLetters" }, "body.password"],
    ["password without a letter", { password: "12345678" }, "body.password"],
    ["password over 72 characters", { password: `A1${"x".repeat(80)}` }, "body.password"],
    ["name too short", { name: "x" }, "body.name"],
    ["unknown field", { isAdmin: true }, "body"],
  ])("returns 422 with a field path for %s", async (_label, override, path) => {
    const res = await register({
      email: uniqueEmail("val"),
      password: PASSWORD,
      name: "Valid Name",
      ...override,
    });
    expectError(res, 422, { message: "Validation failed" });
    expect((res.body.errors as { path: string }[]).map((e) => e.path)).toContain(path);
  });

  it("reports every invalid field at once", async () => {
    const res = await register({ email: "nope", password: "x", name: "y" });
    const paths = (res.body.errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(["body.email", "body.password", "body.name"]));
  });
});

describe("POST /auth/login", () => {
  it("returns the user and a token pair", async () => {
    const user = await createUser();
    const res = await login(user.email);
    expect(res.status).toBe(200);
    expect(res.body.data.user.id).toBe(user.id);
    expect(res.body.data.user).not.toHaveProperty("passwordHash");
    expect(res.body.data.accessToken).toEqual(expect.any(String));
  });

  it("accepts an email in a different case", async () => {
    const user = await createUser();
    expect((await login(user.email.toUpperCase())).status).toBe(200);
  });

  it("gives the same 401 for a wrong password and an unknown email", async () => {
    const user = await createUser();
    const wrongPassword = await login(user.email, "WrongPass1");
    const unknown = await login(uniqueEmail("ghost"));
    expectError(wrongPassword, 401);
    expectError(unknown, 401);
    expect(wrongPassword.body.message).toBe(unknown.body.message);
  });

  it("rejects a Google-only account with the same generic 401", async () => {
    const user = await createUser("RESEARCHER", {
      passwordHash: null,
      googleId: `g-${Date.now()}`,
    });
    expectError(await login(user.email), 401, { message: /invalid email or password/i });
  });

  it("returns 403 for a disabled account", async () => {
    const user = await createUser("RESEARCHER", { isActive: false });
    expectError(await login(user.email), 403);
  });

  it("does not log in a soft-deleted account", async () => {
    const user = await createUser("RESEARCHER", { deletedAt: new Date() });
    expectError(await login(user.email), 401);
  });

  it("returns 422 when fields are missing", async () => {
    expectError(await api().post(`${API}/auth/login`).send({}), 422);
    expectError(await api().post(`${API}/auth/login`).send({ email: "a@b.co" }), 422);
  });
});

describe("refresh tokens", () => {
  const tokensFor = async () => {
    const user = await createUser();
    const res = await login(user.email);
    return { user, ...res.body.data };
  };

  it("issues a new pair that works", async () => {
    const { refreshToken } = await tokensFor();
    const res = await refresh(refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(refreshToken);

    const me = await api()
      .get(`${API}/users/me`)
      .set("Authorization", `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it("accepts each refresh token only once", async () => {
    const { refreshToken } = await tokensFor();
    expect((await refresh(refreshToken)).status).toBe(200);
    expectError(await refresh(refreshToken), 401, { message: /already been used/i });
  });

  it("lets only one of several simultaneous refreshes succeed", async () => {
    const { refreshToken } = await tokensFor();
    const results = await Promise.all(Array.from({ length: 6 }, () => refresh(refreshToken)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 401)).toHaveLength(5);
  });

  it("rejects garbage, and an access token used as a refresh token", async () => {
    const { accessToken } = await tokensFor();
    expectError(await refresh("garbage"), 401);
    expectError(await refresh(accessToken), 401);
  });

  it("rejects a missing token with 422", async () => {
    expectError(await api().post(`${API}/auth/refresh-token`).send({}), 422);
  });

  it("refuses to refresh for a banned user", async () => {
    const { user, refreshToken } = await tokensFor();
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expectError(await refresh(refreshToken), 401);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the refresh token", async () => {
    const user = await createUser();
    const { refreshToken } = (await login(user.email)).body.data;

    const out = await api().post(`${API}/auth/logout`).send({ refreshToken });
    expect(out.status).toBe(200);
    expectError(await refresh(refreshToken), 401);
  });

  it("is safe to repeat", async () => {
    const user = await createUser();
    const { refreshToken } = (await login(user.email)).body.data;
    await api().post(`${API}/auth/logout`).send({ refreshToken });
    expect((await api().post(`${API}/auth/logout`).send({ refreshToken })).status).toBe(200);
  });

  it("rejects an invalid token", async () => {
    expectError(await api().post(`${API}/auth/logout`).send({ refreshToken: "nope" }), 401);
  });
});

describe("POST /auth/google", () => {
  const verifySpy = jest.spyOn(googleClient!, "verifyIdToken");
  const claims = (payload: Record<string, unknown>) =>
    verifySpy.mockResolvedValueOnce({ getPayload: () => payload } as never);
  const google = (role?: string) =>
    api()
      .post(`${API}/auth/google`)
      .send({ idToken: "token", ...(role && { role }) });

  afterEach(() => verifySpy.mockReset());

  it("creates a new passwordless account", async () => {
    const email = uniqueEmail("goo");
    claims({ sub: `sub-${email}`, email, email_verified: true, name: "Google Person" });

    const res = await google("PROGRAM_OWNER");
    expect(res.status).toBe(200);
    expect(res.body.data.user).toMatchObject({
      email,
      role: "PROGRAM_OWNER",
      name: "Google Person",
    });
    const stored = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(stored.passwordHash).toBeNull();
    expect(stored.googleId).toBe(`sub-${email}`);
  });

  it("logs the same Google account in again without creating a duplicate", async () => {
    const email = uniqueEmail("goo");
    const payload = { sub: `sub-${email}`, email, email_verified: true, name: "Repeat" };
    claims(payload);
    const first = await google();
    claims(payload);
    const second = await google();
    expect(second.body.data.user.id).toBe(first.body.data.user.id);
  });

  it("links an existing password account that has the same verified email", async () => {
    const existing = await createUser();
    claims({
      sub: `link-${existing.id}`,
      email: existing.email.toUpperCase(),
      email_verified: true,
    });

    const res = await google();
    expect(res.body.data.user.id).toBe(existing.id);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: existing.id } });
    expect(stored.googleId).toBe(`link-${existing.id}`);
    expect(stored.passwordHash).not.toBeNull();
  });

  it("refuses a different Google account for an already linked email", async () => {
    const existing = await createUser("RESEARCHER", { googleId: `first-${Date.now()}` });
    claims({ sub: `second-${Date.now()}`, email: existing.email, email_verified: true });
    expectError(await google(), 409);
  });

  it("rejects an unverified email", async () => {
    claims({ sub: "s", email: uniqueEmail("unv"), email_verified: false });
    expectError(await google(), 401);
  });

  it("rejects a token Google does not accept", async () => {
    verifySpy.mockRejectedValueOnce(new Error("bad signature") as never);
    expectError(await google(), 401, { message: /invalid google token/i });
  });

  it("blocks a disabled account", async () => {
    const existing = await createUser("RESEARCHER", {
      isActive: false,
      googleId: `off-${Date.now()}`,
    });
    claims({ sub: existing.googleId, email: existing.email, email_verified: true });
    expectError(await google(), 403);
  });

  it("does not let a Google sign-up choose the admin role", async () => {
    expectError(await google("ADMIN"), 422);
  });

  it("requires an idToken", async () => {
    expectError(await api().post(`${API}/auth/google`).send({}), 422);
  });
});

describe("GET/PATCH /users/me", () => {
  it("returns the caller's profile", async () => {
    const user = await createUser();
    const res = await api().get(`${API}/users/me`).set(bearer(user));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: user.id, email: user.email });
    expect(res.body.data).not.toHaveProperty("passwordHash");
  });

  it("updates and trims the name", async () => {
    const user = await createUser();
    const res = await api()
      .patch(`${API}/users/me`)
      .set(bearer(user))
      .send({ name: "  New Name  " });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("New Name");
  });

  it.each([
    ["role", { role: "ADMIN" }],
    ["walletBalance", { walletBalance: 999999 }],
    ["reputation", { reputation: 999 }],
    ["email", { email: "other@example.com" }],
    ["isActive", { isActive: false }],
  ])("rejects a mass-assignment attempt on %s", async (_field, extra) => {
    const user = await createUser();
    const res = await api()
      .patch(`${API}/users/me`)
      .set(bearer(user))
      .send({ name: "Fine Name", ...extra });
    expectError(res, 422);
    const stored = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(stored.role).toBe("RESEARCHER");
    expect(stored.walletBalance).toBe(0);
  });

  it("rejects an empty update", async () => {
    const user = await createUser();
    expectError(await api().patch(`${API}/users/me`).set(bearer(user)).send({}), 422);
  });

  it("requires authentication", async () => {
    expectError(await api().get(`${API}/users/me`), 401);
    expectError(await api().patch(`${API}/users/me`).send({ name: "Nope Nope" }), 401);
  });
});
