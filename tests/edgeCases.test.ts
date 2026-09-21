import { Prisma } from "@prisma/client";
import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError } from "./helpers/api";
import { createUser, purge, uniqueEmail } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let admin: User;

beforeAll(async () => {
  [owner, admin] = await Promise.all([createUser("PROGRAM_OWNER"), createUser("ADMIN")]);
});
afterAll(purge);

describe("response envelope", () => {
  it("wraps a success as { success, message, data }", async () => {
    const res = await api().get(`${API}/users/me`).set(bearer(owner));
    expect(res.body).toEqual({
      success: true,
      message: expect.any(String),
      data: expect.any(Object),
    });
  });

  it("puts pagination in meta on list endpoints", async () => {
    const res = await api().get(`${API}/programs`).set(bearer(admin));
    expect(res.body.meta).toEqual({
      page: 1,
      limit: 10,
      total: expect.any(Number),
      totalPages: expect.any(Number),
    });
  });

  it("wraps every failure as { success: false, message, errors[] }", async () => {
    for (const res of [
      await api().get(`${API}/users/me`),
      await api().get(`${API}/nope`),
      await api().post(`${API}/auth/login`).send({}),
    ]) {
      expect(res.body).toEqual({
        success: false,
        message: expect.any(String),
        errors: expect.any(Array),
      });
    }
  });

  it("reports validation failures per field", async () => {
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ email: "bad", password: "x", name: "y" });
    expect(res.status).toBe(422);
    for (const error of res.body.errors) {
      expect(error).toEqual({ path: expect.any(String), message: expect.any(String) });
    }
  });
});

describe("routing", () => {
  it("returns a JSON 404 naming the method and path for unknown routes", async () => {
    const res = await api().get(`${API}/does-not-exist`);
    expectError(res, 404, { message: /GET \/api\/v1\/does-not-exist/ });
  });

  it("returns 404 for a known path with an unsupported method", async () => {
    expectError(await api().delete(`${API}/programs`).set(bearer(owner)), 404);
    expectError(await api().put(`${API}/auth/login`).send({}), 404);
  });

  it("returns 404 outside /api/v1, and does not expose an unversioned API", async () => {
    expectError(await api().get("/api/programs"), 404);
    expectError(await api().get("/programs"), 404);
  });

  it("serves a health check without authentication", async () => {
    const res = await api().get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });
});

describe("request bodies", () => {
  const post = (body: string, contentType = "application/json") =>
    api().post(`${API}/auth/login`).set("Content-Type", contentType).send(body);

  it("returns 400 for malformed JSON", async () => {
    expectError(await post("{not json"), 400, { message: /malformed json/i });
    expectError(await post('{"email": "a@b.co",}'), 400);
  });

  it("returns 413 for a body over the size limit", async () => {
    const res = await post(JSON.stringify({ email: "a@b.co", password: "x".repeat(200_000) }));
    expectError(res, 413, { message: /too large/i });
  });

  it.each([
    ["an empty body", ""],
    ["a JSON array", "[1,2]"],
  ])("returns 422, not a crash, for %s", async (_label, body) => {
    expectError(await post(body), 422);
  });

  // Express's strict JSON parser accepts only objects and arrays at the top level.
  it.each([
    ["a JSON string", '"hello"'],
    ["a number", "42"],
    ["null", "null"],
  ])("returns 400 for %s", async (_label, body) => {
    expectError(await post(body), 400);
  });

  it("returns 422 for a body sent with the wrong content type", async () => {
    expectError(await post("email=a@b.co&password=x", "application/x-www-form-urlencoded"), 422);
    expectError(await post("hello", "text/plain"), 422);
  });

  it("returns 400 for null characters, which Postgres cannot store", async () => {
    const res = await api()
      .post(`${API}/programs`)
      .set(bearer(owner))
      .send({
        title: "Bad\u0000Title",
        description: "Description that is long enough.",
        scope: { inScope: ["a"] },
      });
    expectError(res, 400, { message: /null character/i });
    expectError(await api().get(`${API}/programs?search=a%00b`).set(bearer(owner)), 400);
  });

  it("accepts unicode, including emoji, and stores it intact", async () => {
    const name = "Zoë 🔒 Ünï 日本語";
    const email = uniqueEmail("uni");
    const res = await api()
      .post(`${API}/auth/register`)
      .send({ email, password: "Passw0rdX", name });
    expect(res.status).toBe(201);
    expect(res.body.data.user.name).toBe(name);
  });

  it("does not let a request grow a nested object without bound", async () => {
    const scope = { inScope: Array.from({ length: 101 }, (_, i) => `asset-${i}`) };
    expectError(
      await api()
        .post(`${API}/programs`)
        .set(bearer(owner))
        .send({ title: "Too many assets", description: "Long enough description.", scope }),
      422,
    );
  });

  it("stores user text as data. Markup and SQL are kept literally.", async () => {
    const title = `<script>alert(1)</script>'; DROP TABLE "User"; --`;
    const res = await api()
      .post(`${API}/programs`)
      .set(bearer(owner))
      .send({
        title,
        description: "Description that is long enough.",
        scope: { inScope: ["a.test"] },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.title).toBe(title);
    expect(await prisma.user.count()).toBeGreaterThan(0);
  });
});

describe("query strings", () => {
  it("does not crash on very large page numbers", async () => {
    const res = await api().get(`${API}/programs?page=1000000000000`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it("ignores unknown query parameters", async () => {
    expect(
      (await api().get(`${API}/programs?utm_source=x&debug=true`).set(bearer(admin))).status,
    ).toBe(200);
  });

  it("rejects a repeated parameter with 422, not a crash", async () => {
    expectError(await api().get(`${API}/programs?limit=5&limit=6`).set(bearer(admin)), 422);
  });

  it.each(["/programs/1", "/reports/xyz", "/payments/%20"])(
    "returns 422 for the malformed id in %s",
    async (path) => {
      expectError(await api().get(`${API}${path}`).set(bearer(admin)), 422);
    },
  );
});

describe("security headers and CORS", () => {
  it("sets helmet headers and hides the framework", async () => {
    const res = await api().get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBeDefined();
    expect(res.headers["strict-transport-security"]).toBeDefined();
    expect(res.headers["content-security-policy"]).toBeDefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows a configured origin", async () => {
    const res = await api().get("/health").set("Origin", "http://localhost:3000");
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not grant CORS access to other origins", async () => {
    const res = await api().get("/health").set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight request for an allowed origin", async () => {
    const res = await api()
      .options(`${API}/auth/login`)
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,content-type");
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-methods"]).toMatch(/POST/);
  });
});

describe("unexpected failures", () => {
  beforeEach(() => jest.spyOn(console, "error").mockImplementation(() => {}));
  afterEach(() => jest.restoreAllMocks());

  it("returns a generic 500 and never leaks the internal error", async () => {
    jest
      .spyOn(prisma.user, "findFirst")
      .mockRejectedValueOnce(new Error("connection string postgres://secret:pw@host"));
    const res = await api()
      .post(`${API}/auth/login`)
      .send({ email: "a@b.co", password: "Passw0rdX" });
    expectError(res, 500, { message: "Internal server error" });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|postgres|connection/i);
  });

  it.each([
    ["P2002", 409, /already exists/i],
    ["P2003", 409, /related resource/i],
    ["P2025", 404, /not found/i],
    ["P2034", 409, /retry/i],
    ["P2024", 503, /busy/i],
    ["P2028", 503, /busy/i],
  ])("maps Prisma error %s to %i", async (code, status, message) => {
    jest.spyOn(prisma.user, "findFirst").mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError("internal detail", {
        code,
        clientVersion: "test",
      }),
    );
    const res = await api()
      .post(`${API}/auth/login`)
      .send({ email: "a@b.co", password: "Passw0rdX" });
    expectError(res, status, { message });
    expect(res.body.message).not.toContain("internal detail");
  });

  it("returns 500, not a crash, for an unmapped Prisma error", async () => {
    jest
      .spyOn(prisma.user, "findFirst")
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("odd", { code: "P9999", clientVersion: "test" }),
      );
    expectError(
      await api().post(`${API}/auth/login`).send({ email: "a@b.co", password: "Passw0rdX" }),
      500,
    );
  });
});
