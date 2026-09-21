import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createReport, createUser, purge, TAG } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let otherOwner: User;
let admin: User;

beforeAll(async () => {
  [owner, otherOwner, admin] = await Promise.all([
    createUser("PROGRAM_OWNER"),
    createUser("PROGRAM_OWNER"),
    createUser("ADMIN"),
  ]);
});
afterAll(purge);

const reward = (id: string, u: User = admin) =>
  api().post(`${API}/reports/${id}/reward`).set(bearer(u));
const poolOf = async (id: string) =>
  (await prisma.program.findUniqueOrThrow({ where: { id } })).poolBalance;
const accepted = (
  program: { id: string },
  researcher: { id: string },
  severity: "LOW" | "HIGH" = "HIGH",
) => createReport(program, researcher, { status: "ACCEPTED", severity });

describe("POST /reports/:id/reward", () => {
  it("pays out: debits the pool, credits the wallet and reputation, and marks the report REWARDED", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 100_000, tiers: { HIGH: 30_000 } });
    const report = await accepted(program, researcher);

    const res = await reward(report.id);
    expect(res.status).toBe(200);
    expect(res.body.data.payout).toMatchObject({
      reportId: report.id,
      amount: 30_000,
      status: "PAID",
    });
    expect(res.body.data.program.poolBalance).toBe(70_000);
    expect(res.body.data.researcher).toMatchObject({
      id: researcher.id,
      walletBalance: 30_000,
      reputation: 7,
    });
    expect(res.body.data.report).toEqual({ id: report.id, status: "REWARDED" });

    expect(await poolOf(program.id)).toBe(70_000);
    const stored = await prisma.report.findUniqueOrThrow({ where: { id: report.id } });
    expect(stored.status).toBe("REWARDED");
    expect(await prisma.payout.count({ where: { reportId: report.id } })).toBe(1);
  });

  it("uses the reward tier for the report's severity", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, {
      poolBalance: 100_000,
      tiers: { LOW: 500, HIGH: 9_000 },
    });
    const res = await reward((await accepted(program, researcher, "LOW")).id);
    expect(res.body.data.payout.amount).toBe(500);
    expect(res.body.data.researcher.reputation).toBe(1);
  });

  it("writes PAYOUT_ISSUED and the status change to the audit log", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 10_000, tiers: { HIGH: 4_000 } });
    const report = await accepted(program, researcher);
    await reward(report.id);

    const rows = await prisma.auditLog.findMany({ where: { entityId: report.id } });
    expect(rows.map((r) => r.action).sort()).toEqual(["PAYOUT_ISSUED", "REPORT_STATUS_CHANGE"]);
    const payoutRow = rows.find((r) => r.action === "PAYOUT_ISSUED")!;
    expect(payoutRow.actorId).toBe(admin.id);
    expect(payoutRow.metadata).toMatchObject({
      amount: 4_000,
      programId: program.id,
      researcherId: researcher.id,
    });
  });

  it("returns 409 ALREADY_REWARDED the second time, and pays nothing more", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 100_000, tiers: { HIGH: 30_000 } });
    const report = await accepted(program, researcher);
    await reward(report.id);

    expectError(await reward(report.id), 409, { code: "ALREADY_REWARDED" });
    expect(await poolOf(program.id)).toBe(70_000);
    expect(await prisma.payout.count({ where: { reportId: report.id } })).toBe(1);
  });

  it("returns 409 INSUFFICIENT_POOL and changes nothing when the pool is too small", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 1_000, tiers: { HIGH: 5_000 } });
    const report = await accepted(program, researcher);

    expectError(await reward(report.id), 409, { code: "INSUFFICIENT_POOL" });
    expect(await poolOf(program.id)).toBe(1_000);
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(
      "ACCEPTED",
    );
    expect(await prisma.payout.count({ where: { reportId: report.id } })).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: researcher.id } })).walletBalance,
    ).toBe(0);
  });

  it("can pay out when the pool exactly equals the reward", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 5_000, tiers: { HIGH: 5_000 } });
    expect((await reward((await accepted(program, researcher)).id)).status).toBe(200);
    expect(await poolOf(program.id)).toBe(0);
  });

  it("returns 409 when the program has no tier for the severity", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 10_000, tiers: { LOW: 100 } });
    expectError(await reward((await accepted(program, researcher, "HIGH")).id), 409, {
      message: /no reward tier/i,
    });
  });

  it.each(["NEW", "TRIAGING", "NEEDS_INFO", "REJECTED", "DUPLICATE"] as const)(
    "will not reward a %s report",
    async (status) => {
      const researcher = await createUser("RESEARCHER");
      const program = await createProgram(owner, { poolBalance: 10_000 });
      const report = await createReport(program, researcher, { status, severity: "HIGH" });
      expectError(await reward(report.id), 409);
      expect(await poolOf(program.id)).toBe(10_000);
    },
  );

  it("is admin-only", async () => {
    const researcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, { poolBalance: 10_000 });
    const report = await accepted(program, researcher);
    expectError(await reward(report.id, owner), 403);
    expectError(await reward(report.id, researcher), 403);
    expect(await poolOf(program.id)).toBe(10_000);
  });

  it("returns 404 for an unknown or soft-deleted report, 422 for a bad id", async () => {
    expectError(await reward(NIL_UUID), 404);
    expectError(await reward("nope"), 422);
  });

  describe("under concurrency", () => {
    it("pays one report once when ten rewards arrive at the same time", async () => {
      const researcher = await createUser("RESEARCHER");
      const program = await createProgram(owner, { poolBalance: 100_000, tiers: { HIGH: 30_000 } });
      const report = await accepted(program, researcher);

      const results = await Promise.all(Array.from({ length: 10 }, () => reward(report.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      const losers = results.filter((r) => r.status !== 200);
      expect(losers).toHaveLength(9);
      for (const loser of losers) expectError(loser, 409, { code: "ALREADY_REWARDED" });

      // The pool moved by exactly one payment, so every losing debit was rolled back.
      expect(await poolOf(program.id)).toBe(70_000);
      expect(await prisma.payout.count({ where: { reportId: report.id } })).toBe(1);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: researcher.id } })).walletBalance,
      ).toBe(30_000);
    });

    it("never overdraws the pool when several reports compete for it", async () => {
      const researcher = await createUser("RESEARCHER");
      const program = await createProgram(owner, {
        poolBalance: 250_000,
        tiers: { HIGH: 100_000 },
      });
      const reports = await Promise.all(
        Array.from({ length: 5 }, () => accepted(program, researcher)),
      );

      const results = await Promise.all(reports.map((r) => reward(r.id)));
      expect(results.filter((r) => r.status === 200)).toHaveLength(2);
      for (const loser of results.filter((r) => r.status !== 200)) {
        expectError(loser, 409, { code: "INSUFFICIENT_POOL" });
      }

      expect(await poolOf(program.id)).toBe(50_000);
      expect(await prisma.payout.count({ where: { programId: program.id } })).toBe(2);
      expect(
        await prisma.report.count({ where: { programId: program.id, status: "REWARDED" } }),
      ).toBe(2);
      expect(
        await prisma.report.count({ where: { programId: program.id, status: "ACCEPTED" } }),
      ).toBe(3);
    });

    it("keeps the ledger balanced: wallet gain equals the sum of payouts, pool loss equals the same", async () => {
      const researcher = await createUser("RESEARCHER");
      const start = 500_000;
      const program = await createProgram(owner, {
        poolBalance: start,
        tiers: { HIGH: 60_000, LOW: 7_000 },
      });
      const reports = await Promise.all([
        accepted(program, researcher, "HIGH"),
        accepted(program, researcher, "LOW"),
        accepted(program, researcher, "HIGH"),
      ]);
      await Promise.all(reports.map((r) => reward(r.id)));

      const paid = (
        await prisma.payout.aggregate({ where: { programId: program.id }, _sum: { amount: true } })
      )._sum.amount;
      expect(paid).toBe(127_000);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: researcher.id } })).walletBalance,
      ).toBe(paid);
      expect(start - (await poolOf(program.id))).toBe(paid);
    });
  });
});

describe("GET /payouts", () => {
  let researcher: User;
  let otherResearcher: User;
  let programId: string;

  beforeAll(async () => {
    researcher = await createUser("RESEARCHER");
    otherResearcher = await createUser("RESEARCHER");
    const program = await createProgram(owner, {
      title: `${TAG} payout list`,
      poolBalance: 1_000_000,
      tiers: { HIGH: 20_000, LOW: 2_000 },
    });
    programId = program.id;
    await reward((await accepted(program, researcher, "HIGH")).id);
    await reward((await accepted(program, researcher, "LOW")).id);
  });

  const list = (u: User, query = "") =>
    api().get(`${API}/payouts?programId=${programId}${query}`).set(bearer(u));

  it("shows a researcher only their own payouts", async () => {
    expect((await list(researcher)).body.meta.total).toBe(2);
    expect((await list(otherResearcher)).body.meta.total).toBe(0);
  });

  it("shows an owner the payouts on their own programs only", async () => {
    expect((await list(owner)).body.meta.total).toBe(2);
    expect((await list(otherOwner)).body.meta.total).toBe(0);
  });

  it("shows admins everything", async () => {
    expect((await list(admin)).body.meta.total).toBe(2);
  });

  it("sorts, paginates and hides researcher emails", async () => {
    const res = await list(admin, "&sortBy=amount&order=desc&limit=1");
    expect(res.body.data.map((p: any) => p.amount)).toEqual([20_000]);
    expect(res.body.meta).toMatchObject({ total: 2, totalPages: 2 });
    expect(res.body.data[0].researcher).toEqual({ id: researcher.id, name: researcher.name });
    expect(res.body.data[0]).toHaveProperty("report.title");
  });

  it("rejects bad query values", async () => {
    for (const bad of ["sortBy=researcherId", "programId=x", "limit=99"]) {
      expectError(await api().get(`${API}/payouts?${bad}`).set(bearer(admin)), 422);
    }
  });
});
