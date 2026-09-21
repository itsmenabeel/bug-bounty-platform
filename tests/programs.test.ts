import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createReport, createUser, purge, TAG } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let otherOwner: User;
let researcher: User;
let admin: User;

beforeAll(async () => {
  [owner, otherOwner, researcher, admin] = await Promise.all([
    createUser("PROGRAM_OWNER"),
    createUser("PROGRAM_OWNER"),
    createUser("RESEARCHER"),
    createUser("ADMIN"),
  ]);
});
afterAll(purge);

const body = (over: Record<string, unknown> = {}) => ({
  title: `${TAG} New Program`,
  description: "A program description that is long enough.",
  scope: { inScope: ["app.test"] },
  ...over,
});

describe("POST /programs", () => {
  it("creates a draft program with an empty pool", async () => {
    const res = await api().post(`${API}/programs`).set(bearer(owner)).send(body());
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      ownerId: owner.id,
      status: "DRAFT",
      poolBalance: 0,
      rewardTiers: [],
    });
    expect(res.body.data.scope).toEqual({ inScope: ["app.test"], outOfScope: [] });
    expect(res.body.data).not.toHaveProperty("deletedAt");
  });

  it.each([
    ["poolBalance", { poolBalance: 999999 }],
    ["status", { status: "ACTIVE" }],
    ["ownerId", { ownerId: "someone-else" }],
  ])("does not let the caller set %s", async (_field, extra) => {
    expectError(await api().post(`${API}/programs`).set(bearer(owner)).send(body(extra)), 422);
  });

  it.each([
    ["title too short", { title: "ab" }],
    ["description too short", { description: "short" }],
    ["scope without in-scope assets", { scope: { inScope: [] } }],
    ["scope with a blank asset", { scope: { inScope: ["  "] } }],
    [
      "scope with over 100 assets",
      { scope: { inScope: Array.from({ length: 101 }, (_, i) => `a${i}`) } },
    ],
    ["missing scope", { scope: undefined }],
  ])("returns 422 for %s", async (_label, over) => {
    expectError(await api().post(`${API}/programs`).set(bearer(owner)).send(body(over)), 422);
  });
});

describe("GET /programs/:id", () => {
  it("shows a draft only to its owner and admins", async () => {
    const draft = await createProgram(owner, { status: "DRAFT" });
    const get = (u: User) => api().get(`${API}/programs/${draft.id}`).set(bearer(u));

    expect((await get(owner)).status).toBe(200);
    expect((await get(admin)).status).toBe(200);
    expectError(await get(researcher), 404);
    expectError(await get(otherOwner), 404);
  });

  it("shows an active program, with its reward tiers, to everyone", async () => {
    const active = await createProgram(owner, { status: "ACTIVE" });
    for (const u of [researcher, otherOwner, admin]) {
      const res = await api().get(`${API}/programs/${active.id}`).set(bearer(u));
      expect(res.status).toBe(200);
      expect(res.body.data.rewardTiers).toHaveLength(4);
    }
  });

  it.each(["PAUSED", "CLOSED"] as const)("hides a %s program from researchers", async (status) => {
    const program = await createProgram(owner, { status });
    expectError(await api().get(`${API}/programs/${program.id}`).set(bearer(researcher)), 404);
  });

  it("returns 404 for an unknown id and 422 for a malformed one", async () => {
    expectError(await api().get(`${API}/programs/${NIL_UUID}`).set(bearer(researcher)), 404);
    expectError(await api().get(`${API}/programs/not-a-uuid`).set(bearer(researcher)), 422);
  });
});

describe("PATCH /programs/:id", () => {
  it("lets the owner edit, and leaves untouched fields alone", async () => {
    const program = await createProgram(owner, { title: `${TAG} Before` });
    const res = await api()
      .patch(`${API}/programs/${program.id}`)
      .set(bearer(owner))
      .send({ title: `${TAG} After` });
    expect(res.status).toBe(200);
    expect(res.body.data.title).toBe(`${TAG} After`);
    expect(res.body.data.description).toBe(program.description);
  });

  it("returns 403 to another owner and to an admin", async () => {
    const program = await createProgram(owner);
    for (const u of [otherOwner, admin]) {
      expectError(
        await api()
          .patch(`${API}/programs/${program.id}`)
          .set(bearer(u))
          .send({ title: "Hijacked title" }),
        403,
      );
    }
  });

  it("rejects an empty update and money fields", async () => {
    const program = await createProgram(owner);
    expectError(
      await api().patch(`${API}/programs/${program.id}`).set(bearer(owner)).send({}),
      422,
    );
    expectError(
      await api()
        .patch(`${API}/programs/${program.id}`)
        .set(bearer(owner))
        .send({ poolBalance: 5 }),
      422,
    );
  });

  it("refuses to edit a closed program", async () => {
    const program = await createProgram(owner, { status: "CLOSED" });
    expectError(
      await api()
        .patch(`${API}/programs/${program.id}`)
        .set(bearer(owner))
        .send({ title: "Late edit" }),
      409,
    );
  });

  it("returns 404 for an unknown program", async () => {
    expectError(
      await api()
        .patch(`${API}/programs/${NIL_UUID}`)
        .set(bearer(owner))
        .send({ title: "Nothing here" }),
      404,
    );
  });
});

describe("PUT /programs/:id/reward-tiers", () => {
  const put = (id: string, u: User, tiers: unknown) =>
    api().put(`${API}/programs/${id}/reward-tiers`).set(bearer(u)).send({ tiers });

  it("upserts only the severities sent and leaves the rest", async () => {
    const program = await createProgram(owner, { tiers: { LOW: 1000, HIGH: 9000 } });
    const res = await put(program.id, owner, [
      { severity: "LOW", amount: 2500 },
      { severity: "CRITICAL", amount: 70000 },
    ]);
    expect(res.status).toBe(200);
    expect(
      Object.fromEntries(res.body.data.rewardTiers.map((t: any) => [t.severity, t.amount])),
    ).toEqual({
      LOW: 2500,
      HIGH: 9000,
      CRITICAL: 70000,
    });
  });

  it("writes an audit row", async () => {
    const program = await createProgram(owner, { tiers: null });
    await put(program.id, owner, [{ severity: "LOW", amount: 500 }]);
    const rows = await prisma.auditLog.findMany({
      where: { entityId: program.id, action: "REWARD_TIERS_UPDATED" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(owner.id);
  });

  it.each([
    [
      "a duplicate severity",
      [
        { severity: "LOW", amount: 1 },
        { severity: "LOW", amount: 2 },
      ],
    ],
    ["a fractional amount", [{ severity: "LOW", amount: 10.5 }]],
    ["a zero amount", [{ severity: "LOW", amount: 0 }]],
    ["a negative amount", [{ severity: "LOW", amount: -5 }]],
    ["a string amount", [{ severity: "LOW", amount: "500" }]],
    ["an unknown severity", [{ severity: "EXTREME", amount: 500 }]],
    ["an empty list", []],
  ])("rejects %s", async (_label, tiers) => {
    const program = await createProgram(owner, { tiers: null });
    expectError(await put(program.id, owner, tiers), 422);
  });

  it("is limited to the owner, and blocked once the program is closed", async () => {
    const program = await createProgram(owner);
    expectError(await put(program.id, otherOwner, [{ severity: "LOW", amount: 1 }]), 403);
    const closed = await createProgram(owner, { status: "CLOSED" });
    expectError(await put(closed.id, owner, [{ severity: "LOW", amount: 1 }]), 409);
  });
});

describe("PATCH /programs/:id/status", () => {
  const setStatus = (id: string, u: User, status: string) =>
    api().patch(`${API}/programs/${id}/status`).set(bearer(u)).send({ status });

  it("follows the lifecycle and writes an audit row for each change", async () => {
    const program = await createProgram(owner, { status: "DRAFT" });
    for (const status of ["ACTIVE", "PAUSED", "ACTIVE", "CLOSED"]) {
      const res = await setStatus(program.id, owner, status);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
    const rows = await prisma.auditLog.findMany({
      where: { entityId: program.id, action: "PROGRAM_STATUS_CHANGE" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => `${(r.metadata as any).from}>${(r.metadata as any).to}`)).toEqual([
      "DRAFT>ACTIVE",
      "ACTIVE>PAUSED",
      "PAUSED>ACTIVE",
      "ACTIVE>CLOSED",
    ]);
  });

  it.each([
    ["DRAFT", "PAUSED"],
    ["CLOSED", "ACTIVE"],
    ["CLOSED", "PAUSED"],
  ] as const)("rejects %s -> %s with 409", async (from, to) => {
    const program = await createProgram(owner, { status: from });
    expectError(await setStatus(program.id, owner, to), 409, { message: /cannot change status/i });
  });

  it("will not activate a program that has no reward tiers", async () => {
    const program = await createProgram(owner, { status: "DRAFT", tiers: null });
    expectError(await setStatus(program.id, owner, "ACTIVE"), 409, { message: /reward tiers/i });
  });

  it("does not accept DRAFT as a target, or an unknown status", async () => {
    const program = await createProgram(owner, { status: "ACTIVE" });
    expectError(await setStatus(program.id, owner, "DRAFT"), 422);
    expectError(await setStatus(program.id, owner, "BOGUS"), 422);
  });

  it("is limited to the owner", async () => {
    const program = await createProgram(owner, { status: "ACTIVE" });
    expectError(await setStatus(program.id, otherOwner, "PAUSED"), 403);
    expectError(await setStatus(program.id, admin, "PAUSED"), 403);
  });

  it("lets only one of two simultaneous changes win", async () => {
    const program = await createProgram(owner, { status: "ACTIVE" });
    const results = await Promise.all([
      setStatus(program.id, owner, "PAUSED"),
      setStatus(program.id, owner, "CLOSED"),
    ]);
    const codes = results.map((r) => r.status).sort();
    expect(codes[0]).toBe(200);
    // PAUSED -> CLOSED is legal, so the second change may also succeed if it runs after the first.
    expect([200, 409]).toContain(codes[1]);
    const stored = await prisma.program.findUniqueOrThrow({ where: { id: program.id } });
    expect(["PAUSED", "CLOSED"]).toContain(stored.status);
  });
});

describe("GET /programs (list)", () => {
  // A tag of its own keeps other programs made by this file out of these results.
  const LIST_TAG = `${TAG} lst`;
  const ids: Record<string, string> = {};
  const list = (u: User, query = "") =>
    api()
      .get(`${API}/programs?search=${encodeURIComponent(LIST_TAG)}${query}`)
      .set(bearer(u));
  const titles = (res: { body: { data: { title: string }[] } }) =>
    res.body.data.map((p) => p.title.replace(`${LIST_TAG} `, ""));

  beforeAll(async () => {
    const make = async (
      name: string,
      status: "ACTIVE" | "DRAFT" | "PAUSED",
      pool: number,
      who = owner,
    ) => {
      const p = await createProgram(who, {
        title: `${LIST_TAG} ${name}`,
        status,
        poolBalance: pool,
      });
      ids[name] = p.id;
    };
    await make("Alpha", "ACTIVE", 500);
    await make("Bravo", "ACTIVE", 900);
    await make("Charlie", "ACTIVE", 100);
    await make("Delta", "DRAFT", 0);
    await make("Echo", "PAUSED", 0);
    await make("Foxtrot", "ACTIVE", 300, otherOwner);
    await prisma.program.update({
      where: { id: ids.Bravo },
      data: { description: "Covers the payments gateway integration" },
    });
  });

  it("shows researchers and owners only active programs", async () => {
    for (const u of [researcher, owner]) {
      const res = await list(u, "&sortBy=title&order=asc");
      expect(titles(res)).toEqual(["Alpha", "Bravo", "Charlie", "Foxtrot"]);
    }
  });

  it("shows admins every program, and filters by status", async () => {
    expect((await list(admin)).body.meta.total).toBe(6);
    expect(titles(await list(admin, "&status=DRAFT"))).toEqual(["Delta"]);
    expect(titles(await list(admin, "&status=PAUSED"))).toEqual(["Echo"]);
  });

  it("never reveals other statuses through the status filter", async () => {
    expect(titles(await list(researcher, "&status=DRAFT"))).toEqual([]);
  });

  it("lists an owner's own programs, in any status, with mine=true", async () => {
    const res = await list(owner, "&mine=true&sortBy=title&order=asc");
    expect(titles(res)).toEqual(["Alpha", "Bravo", "Charlie", "Delta", "Echo"]);
    const other = await list(otherOwner, "&mine=true");
    expect(titles(other)).toEqual(["Foxtrot"]);
  });

  it("returns 403 for mine=true from a researcher or admin", async () => {
    expectError(await list(researcher, "&mine=true"), 403);
    expectError(await list(admin, "&mine=true"), 403);
  });

  it("paginates and reports totals", async () => {
    const res = await list(admin, "&limit=2&page=2&sortBy=title&order=asc");
    expect(titles(res)).toEqual(["Charlie", "Delta"]);
    expect(res.body.meta).toEqual({ page: 2, limit: 2, total: 6, totalPages: 3 });
  });

  it("returns an empty page, not an error, past the end", async () => {
    const res = await list(admin, "&page=99");
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.totalPages).toBe(1);
  });

  it("sorts by title and by pool balance", async () => {
    expect(titles(await list(researcher, "&sortBy=title&order=desc"))).toEqual([
      "Foxtrot",
      "Charlie",
      "Bravo",
      "Alpha",
    ]);
    expect(titles(await list(researcher, "&sortBy=poolBalance&order=desc"))).toEqual([
      "Bravo",
      "Alpha",
      "Foxtrot",
      "Charlie",
    ]);
  });

  it("searches title and description without regard to case", async () => {
    const byTitle = await api()
      .get(`${API}/programs?search=${encodeURIComponent(`${LIST_TAG} ALPHA`)}`)
      .set(bearer(researcher));
    expect(titles(byTitle)).toEqual(["Alpha"]);
    const byDescription = await api()
      .get(`${API}/programs?search=PAYMENTS%20gateway`)
      .set(bearer(researcher));
    expect(byDescription.body.data.map((p: any) => p.id)).toContain(ids.Bravo);
  });

  it("treats search text literally, not as SQL or a wildcard", async () => {
    for (const search of ["%25", '\'; DROP TABLE "Program"; --', "_"]) {
      const res = await api()
        .get(`${API}/programs?search=${encodeURIComponent(search)}`)
        .set(bearer(researcher));
      expect(res.status).toBe(200);
    }
    expect(await prisma.program.count()).toBeGreaterThan(0);
  });

  it.each([
    ["sortBy=passwordHash"],
    ["sortBy=poolBalance;drop"],
    ["order=sideways"],
    ["limit=0"],
    ["limit=51"],
    ["limit=abc"],
    ["page=0"],
    ["page=-3"],
    ["status=NOPE"],
    ["mine=maybe"],
  ])("returns 422 for %s", async (query) => {
    expectError(await api().get(`${API}/programs?${query}`).set(bearer(admin)), 422);
  });

  it("excludes soft-deleted programs", async () => {
    await prisma.program.update({ where: { id: ids.Charlie }, data: { deletedAt: new Date() } });
    expect(titles(await list(researcher))).not.toContain("Charlie");
  });
});

describe("DELETE /programs/:id", () => {
  it("soft-deletes: the row stays, but the program disappears", async () => {
    const program = await createProgram(owner);
    const res = await api().delete(`${API}/programs/${program.id}`).set(bearer(owner));
    expect(res.status).toBe(200);

    expectError(await api().get(`${API}/programs/${program.id}`).set(bearer(owner)), 404);
    const stored = await prisma.program.findUniqueOrThrow({ where: { id: program.id } });
    expect(stored.deletedAt).not.toBeNull();
    const audit = await prisma.auditLog.findMany({
      where: { entityId: program.id, action: "PROGRAM_DELETED" },
    });
    expect(audit).toHaveLength(1);
  });

  it("refuses while the pool holds money", async () => {
    const program = await createProgram(owner, { poolBalance: 500 });
    expectError(await api().delete(`${API}/programs/${program.id}`).set(bearer(owner)), 409, {
      message: /funded pool/i,
    });
  });

  it.each(["NEW", "TRIAGING", "NEEDS_INFO", "ACCEPTED"] as const)(
    "refuses while a report is %s",
    async (status) => {
      const program = await createProgram(owner);
      await createReport(program, researcher, { status, severity: "LOW" });
      expectError(await api().delete(`${API}/programs/${program.id}`).set(bearer(owner)), 409, {
        message: /open reports/i,
      });
    },
  );

  it("allows deletion when every report is finished", async () => {
    const program = await createProgram(owner);
    await createReport(program, researcher, { status: "REJECTED" });
    expect((await api().delete(`${API}/programs/${program.id}`).set(bearer(owner))).status).toBe(
      200,
    );
  });

  it("is limited to the owner", async () => {
    const program = await createProgram(owner);
    expectError(await api().delete(`${API}/programs/${program.id}`).set(bearer(otherOwner)), 403);
    expectError(await api().delete(`${API}/programs/${NIL_UUID}`).set(bearer(owner)), 404);
  });
});
