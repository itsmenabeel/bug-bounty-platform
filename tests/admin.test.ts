import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createReport, createUser, purge, TAG } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
let admin: User;
let owner: User;
let researcher: User;

beforeAll(async () => {
  [admin, owner, researcher] = await Promise.all([
    createUser("ADMIN"),
    createUser("PROGRAM_OWNER"),
    createUser("RESEARCHER"),
  ]);
});
afterAll(purge);

const setRole = (id: string, role: string, u: User = admin) =>
  api().patch(`${API}/admin/users/${id}/role`).set(bearer(u)).send({ role });
const setStatus = (id: string, body: Record<string, unknown>, u: User = admin) =>
  api().patch(`${API}/admin/users/${id}/status`).set(bearer(u)).send(body);
const me = (u: { token: string }) => api().get(`${API}/users/me`).set(bearer(u));
const auditActions = async (entityId: string) =>
  (await prisma.auditLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } })).map(
    (r) => r.action,
  );

describe("GET /admin/users", () => {
  const listTag = `${TAG}.list`;
  beforeAll(async () => {
    await createUser("RESEARCHER", {
      email: `${listTag}.alice@example.com`,
      name: "Alice Adminlist",
    });
    await createUser("PROGRAM_OWNER", {
      email: `${listTag}.bob@example.com`,
      name: "Bob Adminlist",
      isActive: false,
    });
    await createUser("RESEARCHER", {
      email: `${listTag}.carol@example.com`,
      name: "Carol Adminlist",
      reputation: 50,
    });
  });
  const list = (query = "") =>
    api()
      .get(`${API}/admin/users?search=${encodeURIComponent(listTag)}${query}`)
      .set(bearer(admin));
  const emails = (res: { body: { data: { email: string }[] } }) =>
    res.body.data.map((u) => u.email.replace(`${listTag}.`, "").replace("@example.com", ""));

  it("lists users without ever returning password hashes", async () => {
    const res = await list();
    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBe(3);
    for (const user of res.body.data) {
      expect(user).not.toHaveProperty("passwordHash");
      expect(user).not.toHaveProperty("deletedAt");
    }
  });

  it("filters by role and by active status", async () => {
    expect(emails(await list("&role=PROGRAM_OWNER"))).toEqual(["bob"]);
    expect(emails(await list("&isActive=false"))).toEqual(["bob"]);
    expect((await list("&isActive=true")).body.meta.total).toBe(2);
  });

  it("searches name and email without regard to case", async () => {
    const byName = await api()
      .get(`${API}/admin/users?search=CAROL%20adminlist`)
      .set(bearer(admin));
    expect(byName.body.data).toHaveLength(1);
    expect((await list()).body.meta.total).toBe(3);
  });

  it("sorts and paginates", async () => {
    expect(emails(await list("&sortBy=email&order=asc"))).toEqual(["alice", "bob", "carol"]);
    expect(emails(await list("&sortBy=reputation&order=desc&limit=1"))).toEqual(["carol"]);
    expect((await list("&limit=2&page=2")).body.meta).toMatchObject({
      page: 2,
      total: 3,
      totalPages: 2,
    });
  });

  it("leaves out soft-deleted users", async () => {
    const gone = await createUser("RESEARCHER", {
      email: `${listTag}.gone@example.com`,
      deletedAt: new Date(),
    });
    expect(emails(await list())).not.toContain("gone");
    expect(gone.deletedAt).not.toBeNull();
  });

  it.each(["role=BOSS", "isActive=maybe", "sortBy=passwordHash", "limit=0"])(
    "returns 422 for %s",
    async (bad) => {
      expectError(await api().get(`${API}/admin/users?${bad}`).set(bearer(admin)), 422);
    },
  );
});

describe("PATCH /admin/users/:id/role", () => {
  it("changes the role, and it applies to the user's existing token straight away", async () => {
    const target = await createUser("RESEARCHER");
    const asOwner = () =>
      api()
        .post(`${API}/programs`)
        .set(bearer(target))
        .send({
          title: `${TAG} promoted`,
          description: "Created after promotion.",
          scope: { inScope: ["a.test"] },
        });

    expectError(await asOwner(), 403);
    const res = await setRole(target.id, "PROGRAM_OWNER");
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe("PROGRAM_OWNER");
    expect((await asOwner()).status).toBe(201);

    await prisma.program.deleteMany({ where: { ownerId: target.id } });
    expect((await setRole(target.id, "RESEARCHER")).status).toBe(200);
    expectError(await asOwner(), 403);
  });

  it("records each change in the audit log with the old and new role", async () => {
    const target = await createUser("RESEARCHER");
    await setRole(target.id, "ADMIN");
    await setRole(target.id, "RESEARCHER");
    const rows = await prisma.auditLog.findMany({
      where: { entityId: target.id, action: "ROLE_UPDATED" },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => `${(r.metadata as any).from}>${(r.metadata as any).to}`)).toEqual([
      "RESEARCHER>ADMIN",
      "ADMIN>RESEARCHER",
    ]);
    expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
  });

  it("gives a promoted admin, and takes from a demoted one, access to admin routes", async () => {
    const target = await createUser("RESEARCHER");
    expectError(await api().get(`${API}/admin/users`).set(bearer(target)), 403);
    await setRole(target.id, "ADMIN");
    expect((await api().get(`${API}/admin/users`).set(bearer(target))).status).toBe(200);
    await setRole(target.id, "RESEARCHER");
    expectError(await api().get(`${API}/admin/users`).set(bearer(target)), 403);
  });

  it("does nothing, and logs nothing, when the role is unchanged", async () => {
    const target = await createUser("RESEARCHER");
    expect((await setRole(target.id, "RESEARCHER")).status).toBe(200);
    expect(await auditActions(target.id)).toEqual([]);
  });

  it("will not let an admin change their own role", async () => {
    const self = await createUser("ADMIN");
    expectError(await setRole(self.id, "RESEARCHER", self), 409, { message: /your own account/i });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: self.id } })).role).toBe("ADMIN");
  });

  it("will not demote an owner who still owns programs", async () => {
    const target = await createUser("PROGRAM_OWNER");
    const program = await createProgram(target, { status: "ACTIVE" });
    expectError(await setRole(target.id, "RESEARCHER"), 409, { message: /owns programs/i });

    await prisma.program.update({ where: { id: program.id }, data: { deletedAt: new Date() } });
    expect((await setRole(target.id, "RESEARCHER")).status).toBe(200);
  });

  it("can demote another admin when other admins remain", async () => {
    const other = await createUser("ADMIN");
    expect((await setRole(other.id, "RESEARCHER")).status).toBe(200);
  });

  it("returns 404 for an unknown user, 422 for bad input", async () => {
    expectError(await setRole(NIL_UUID, "ADMIN"), 404);
    expectError(await setRole("nope", "ADMIN"), 422);
    const target = await createUser("RESEARCHER");
    expectError(await setRole(target.id, "BOSS"), 422);
    expectError(
      await api()
        .patch(`${API}/admin/users/${target.id}/role`)
        .set(bearer(admin))
        .send({ role: "ADMIN", isActive: false }),
      422,
    );
  });

  it("does not act on a soft-deleted user", async () => {
    const gone = await createUser("RESEARCHER", { deletedAt: new Date() });
    expectError(await setRole(gone.id, "ADMIN"), 404);
  });
});

describe("PATCH /admin/users/:id/status (ban and unban)", () => {
  it("locks a banned user out at once: token, login and refresh all fail", async () => {
    const target = await createUser("RESEARCHER");
    const login = await api()
      .post(`${API}/auth/login`)
      .send({ email: target.email, password: "Passw0rdX" });
    const { refreshToken, accessToken } = login.body.data;
    expect((await me({ token: accessToken })).status).toBe(200);

    const ban = await setStatus(target.id, { isActive: false, reason: "Spamming reports" });
    expect(ban.status).toBe(200);
    expect(ban.body.data).toMatchObject({ isActive: false, pausedPrograms: 0 });

    expectError(await me({ token: accessToken }), 401);
    expectError(
      await api().post(`${API}/auth/login`).send({ email: target.email, password: "Passw0rdX" }),
      403,
    );
    expectError(await api().post(`${API}/auth/refresh-token`).send({ refreshToken }), 401);
  });

  it("restores access on unban with the same token", async () => {
    const target = await createUser("RESEARCHER");
    await setStatus(target.id, { isActive: false });
    expectError(await me(target), 401);
    expect((await setStatus(target.id, { isActive: true })).status).toBe(200);
    expect((await me(target)).status).toBe(200);
  });

  it("audits the ban with its reason and who did it", async () => {
    const target = await createUser("RESEARCHER");
    await setStatus(target.id, { isActive: false, reason: "Fraud" });
    await setStatus(target.id, { isActive: true });
    const rows = await prisma.auditLog.findMany({
      where: { entityId: target.id },
      orderBy: { createdAt: "asc" },
    });
    expect(rows.map((r) => r.action)).toEqual(["USER_BANNED", "USER_UNBANNED"]);
    expect(rows[0].metadata).toMatchObject({ reason: "Fraud", pausedPrograms: 0 });
    expect(rows.every((r) => r.actorId === admin.id)).toBe(true);
  });

  it("does nothing on a repeat, and refuses self-bans", async () => {
    const target = await createUser("RESEARCHER");
    await setStatus(target.id, { isActive: false });
    const again = await setStatus(target.id, { isActive: false });
    expect(again.status).toBe(200);
    expect(await auditActions(target.id)).toEqual(["USER_BANNED"]);

    const self = await createUser("ADMIN");
    expectError(await setStatus(self.id, { isActive: false }, self), 409, {
      message: /your own account/i,
    });
  });

  it("pauses the owner's active programs, and only those", async () => {
    const target = await createUser("PROGRAM_OWNER");
    const [a, b, draft, paused, closed] = await Promise.all([
      createProgram(target, { status: "ACTIVE" }),
      createProgram(target, { status: "ACTIVE" }),
      createProgram(target, { status: "DRAFT" }),
      createProgram(target, { status: "PAUSED" }),
      createProgram(target, { status: "CLOSED" }),
    ]);

    const ban = await setStatus(target.id, { isActive: false, reason: "Fraud" });
    expect(ban.body.data.pausedPrograms).toBe(2);

    const statusOf = async (id: string) =>
      (await prisma.program.findUniqueOrThrow({ where: { id } })).status;
    expect([await statusOf(a.id), await statusOf(b.id)]).toEqual(["PAUSED", "PAUSED"]);
    expect([
      await statusOf(draft.id),
      await statusOf(paused.id),
      await statusOf(closed.id),
    ]).toEqual(["DRAFT", "PAUSED", "CLOSED"]);

    const programAudit = await prisma.auditLog.findMany({
      where: { entityId: a.id, action: "PROGRAM_STATUS_CHANGE" },
    });
    expect(programAudit).toHaveLength(1);
    expect(programAudit[0].metadata).toMatchObject({
      from: "ACTIVE",
      to: "PAUSED",
      reason: "owner_banned",
    });
    expect(programAudit[0].actorId).toBe(admin.id);
    const banAudit = await prisma.auditLog.findFirstOrThrow({
      where: { entityId: target.id, action: "USER_BANNED" },
    });
    expect(banAudit.metadata).toMatchObject({ pausedPrograms: 2 });
  });

  it("stops researchers reporting to the paused program", async () => {
    const target = await createUser("PROGRAM_OWNER");
    const program = await createProgram(target, { status: "ACTIVE" });
    const submit = () =>
      api()
        .post(`${API}/reports`)
        .set(bearer(researcher))
        .send({
          programId: program.id,
          title: `${TAG} banned owner report`,
          description: "Long enough description for validation.",
        });

    expect((await submit()).status).toBe(201);
    await setStatus(target.id, { isActive: false });
    expectError(await submit(), 409);
  });

  it("does not resume programs on unban; the owner reactivates them", async () => {
    const target = await createUser("PROGRAM_OWNER");
    const program = await createProgram(target, { status: "ACTIVE" });
    await setStatus(target.id, { isActive: false });
    const unban = await setStatus(target.id, { isActive: true });
    expect(unban.body.data.pausedPrograms).toBe(0);
    expect((await prisma.program.findUniqueOrThrow({ where: { id: program.id } })).status).toBe(
      "PAUSED",
    );

    const resume = await api()
      .patch(`${API}/programs/${program.id}/status`)
      .set(bearer(target))
      .send({ status: "ACTIVE" });
    expect(resume.status).toBe(200);
    expect(resume.body.data.status).toBe("ACTIVE");
  });

  it("can ban another admin while other admins remain", async () => {
    const other = await createUser("ADMIN");
    expect((await setStatus(other.id, { isActive: false })).status).toBe(200);
  });

  it("returns 404 for an unknown user, 422 for bad input", async () => {
    expectError(await setStatus(NIL_UUID, { isActive: false }), 404);
    const target = await createUser("RESEARCHER");
    for (const bad of [
      {},
      { isActive: "no" },
      { isActive: false, extra: 1 },
      { isActive: false, reason: "" },
    ]) {
      expectError(await setStatus(target.id, bad), 422);
    }
  });
});

describe("GET /admin/audit-logs", () => {
  it("filters by entity, action and actor, and reports the actor without their email", async () => {
    const target = await createUser("RESEARCHER");
    await setRole(target.id, "PROGRAM_OWNER");
    await setStatus(target.id, { isActive: false });

    const q = (query: string) => api().get(`${API}/admin/audit-logs?${query}`).set(bearer(admin));
    const byEntity = await q(`entityId=${target.id}&sortBy=createdAt&order=asc`);
    expect(byEntity.body.data.map((l: any) => l.action)).toEqual(["ROLE_UPDATED", "USER_BANNED"]);
    expect(byEntity.body.data[0].actor).toEqual({ id: admin.id, name: admin.name, role: "ADMIN" });
    expect((await q(`entityId=${target.id}&action=USER_BANNED`)).body.meta.total).toBe(1);
    expect(
      (await q(`entityId=${target.id}&entityType=User&actorId=${admin.id}`)).body.meta.total,
    ).toBe(2);
    expect((await q(`entityId=${target.id}&entityType=Program`)).body.meta.total).toBe(0);
  });

  it("filters by date range", async () => {
    const target = await createUser("RESEARCHER");
    await setStatus(target.id, { isActive: false });
    const q = (range: string) =>
      api().get(`${API}/admin/audit-logs?entityId=${target.id}&${range}`).set(bearer(admin));
    expect((await q("from=2000-01-01")).body.meta.total).toBe(1);
    expect((await q("from=2999-01-01")).body.meta.total).toBe(0);
    expect((await q("to=2000-01-01")).body.meta.total).toBe(0);
  });

  it.each([
    "entityId=abc",
    "actorId=abc",
    "from=notadate",
    "from=2030-01-01&to=2020-01-01",
    "sortBy=action",
    "limit=500",
  ])("returns 422 for %s", async (bad) => {
    expectError(await api().get(`${API}/admin/audit-logs?${bad}`).set(bearer(admin)), 422);
  });
});

describe("GET /admin/dashboard-stats", () => {
  const stats = async () =>
    (await api().get(`${API}/admin/dashboard-stats`).set(bearer(admin))).body.data;

  it("returns every section with every enum key present, even at zero", async () => {
    const data = await stats();
    expect(Object.keys(data).sort()).toEqual(["money", "programs", "reports", "users"]);
    expect(Object.keys(data.users.byRole).sort()).toEqual(["ADMIN", "PROGRAM_OWNER", "RESEARCHER"]);
    expect(Object.keys(data.programs.byStatus).sort()).toEqual([
      "ACTIVE",
      "CLOSED",
      "DRAFT",
      "PAUSED",
    ]);
    expect(Object.keys(data.reports.byStatus).sort()).toEqual([
      "ACCEPTED",
      "DUPLICATE",
      "NEEDS_INFO",
      "NEW",
      "REJECTED",
      "REWARDED",
      "TRIAGING",
    ]);
    expect(Object.keys(data.reports.bySeverity).sort()).toEqual([
      "CRITICAL",
      "HIGH",
      "LOW",
      "MEDIUM",
    ]);
    expect(Object.keys(data.money).sort()).toEqual([
      "payoutCount",
      "pendingPayments",
      "totalFunded",
      "totalPaidOut",
    ]);
  });

  it("returns whole numbers only", async () => {
    const data = await stats();
    const numbers = [
      data.users.total,
      data.users.banned,
      ...Object.values(data.users.byRole),
      data.programs.total,
      data.programs.totalPoolBalance,
      ...Object.values(data.programs.byStatus),
      data.reports.total,
      data.reports.createdLast7Days,
      ...Object.values(data.reports.byStatus),
      ...Object.values(data.reports.bySeverity),
      ...Object.values(data.money),
    ] as number[];
    for (const value of numbers) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it("reflects new data. Other test files share the database, so it checks for at least the increase.", async () => {
    const before = await stats();
    const program = await createProgram(owner, { status: "ACTIVE", poolBalance: 12_345 });
    await createReport(program, researcher, { status: "ACCEPTED", severity: "MEDIUM" });
    await createUser("RESEARCHER", { isActive: false });
    const after = await stats();

    expect(after.programs.total).toBeGreaterThanOrEqual(before.programs.total + 1);
    expect(after.programs.byStatus.ACTIVE).toBeGreaterThanOrEqual(
      before.programs.byStatus.ACTIVE + 1,
    );
    expect(after.programs.totalPoolBalance).toBeGreaterThanOrEqual(
      before.programs.totalPoolBalance + 12_345,
    );
    expect(after.reports.byStatus.ACCEPTED).toBeGreaterThanOrEqual(
      before.reports.byStatus.ACCEPTED + 1,
    );
    expect(after.reports.bySeverity.MEDIUM).toBeGreaterThanOrEqual(
      before.reports.bySeverity.MEDIUM + 1,
    );
    expect(after.reports.createdLast7Days).toBeGreaterThanOrEqual(
      before.reports.createdLast7Days + 1,
    );
    expect(after.users.banned).toBeGreaterThanOrEqual(before.users.banned + 1);
  });
});
