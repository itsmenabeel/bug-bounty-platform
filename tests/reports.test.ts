import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createReport, createUser, purge, TAG } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
type Program = Awaited<ReturnType<typeof createProgram>>;
let owner: User;
let otherOwner: User;
let researcher: User;
let otherResearcher: User;
let admin: User;
let program: Program;

beforeAll(async () => {
  [owner, otherOwner, researcher, otherResearcher, admin] = await Promise.all([
    createUser("PROGRAM_OWNER"),
    createUser("PROGRAM_OWNER"),
    createUser("RESEARCHER"),
    createUser("RESEARCHER"),
    createUser("ADMIN"),
  ]);
  program = await createProgram(owner, { status: "ACTIVE" });
});
afterAll(purge);

const payload = (programId: string, over: Record<string, unknown> = {}) => ({
  programId,
  title: `${TAG} Stored XSS in profile`,
  description: "Payload placed in the name field executes on the profile page.",
  ...over,
});
const submit = (u: User, over: Record<string, unknown> = {}, programId = program.id) =>
  api().post(`${API}/reports`).set(bearer(u)).send(payload(programId, over));
const triage = (id: string, body: Record<string, unknown>, u: User = admin) =>
  api().patch(`${API}/reports/${id}/status`).set(bearer(u)).send(body);
const get = (id: string, u: User) => api().get(`${API}/reports/${id}`).set(bearer(u));
const auditOf = async (id: string) =>
  (await prisma.auditLog.findMany({ where: { entityId: id }, orderBy: { createdAt: "asc" } })).map(
    (row) => ({
      action: row.action,
      actorId: row.actorId,
      metadata: row.metadata as Record<string, unknown> | null,
    }),
  );

describe("POST /reports", () => {
  it("creates a NEW report with no severity", async () => {
    const res = await submit(researcher);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      status: "NEW",
      severity: null,
      duplicateOfId: null,
      researcherId: researcher.id,
      program: { id: program.id },
    });
  });

  it("returns 403 to owners and admins", async () => {
    expectError(await submit(owner), 403);
    expectError(await submit(admin), 403);
  });

  it("hides draft programs, and refuses paused or closed ones", async () => {
    const draft = await createProgram(owner, { status: "DRAFT" });
    const paused = await createProgram(owner, { status: "PAUSED" });
    const closed = await createProgram(owner, { status: "CLOSED" });
    expectError(await submit(researcher, {}, draft.id), 404);
    expectError(await submit(researcher, {}, paused.id), 409);
    expectError(await submit(researcher, {}, closed.id), 409);
    expectError(await submit(researcher, {}, NIL_UUID), 404);
  });

  it("will not accept a soft-deleted program", async () => {
    const gone = await createProgram(owner, { status: "ACTIVE" });
    await prisma.program.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expectError(await submit(researcher, {}, gone.id), 404);
  });

  it.each([
    ["severity", { severity: "CRITICAL" }],
    ["status", { status: "ACCEPTED" }],
    ["researcherId", { researcherId: "someone" }],
    ["duplicateOfId", { duplicateOfId: NIL_UUID }],
  ])("does not let the researcher set %s", async (_field, extra) => {
    expectError(await submit(researcher, extra), 422);
  });

  it.each([
    ["short title", { title: "abc" }],
    ["short description", { description: "too short" }],
    ["title over 200 characters", { title: "x".repeat(201) }],
    ["malformed programId", { programId: "nope" }],
  ])("returns 422 for a %s", async (_label, over) => {
    expectError(await submit(researcher, over), 422);
  });
});

describe("report visibility", () => {
  let report: Awaited<ReturnType<typeof createReport>>;
  beforeAll(async () => {
    report = await createReport(program, researcher);
  });

  it("shows a report to its author, the program owner, and admins", async () => {
    for (const u of [researcher, owner, admin]) expect((await get(report.id, u)).status).toBe(200);
  });

  it("returns 404 to anyone else, so existence is not revealed", async () => {
    expectError(await get(report.id, otherResearcher), 404);
    expectError(await get(report.id, otherOwner), 404);
    expectError(await get(NIL_UUID, admin), 404);
    expectError(await get("not-a-uuid", admin), 422);
  });

  it("scopes the list to what each role may see", async () => {
    const mine = `${TAG} scoped`;
    const other = await createProgram(otherOwner, { status: "ACTIVE" });
    await createReport(program, researcher, { title: `${mine} one` });
    await createReport(other, researcher, { title: `${mine} two` });
    await createReport(program, otherResearcher, { title: `${mine} three` });
    const count = async (u: User) =>
      (
        await api()
          .get(`${API}/reports?search=${encodeURIComponent(mine)}`)
          .set(bearer(u))
      ).body.meta.total;

    expect(await count(researcher)).toBe(2);
    expect(await count(otherResearcher)).toBe(1);
    expect(await count(owner)).toBe(2);
    expect(await count(otherOwner)).toBe(1);
    expect(await count(admin)).toBe(3);
  });

  it("filters by status, severity and program, and sorts and paginates", async () => {
    const tag = `${TAG} filt`;
    const p2 = await createProgram(owner, { status: "ACTIVE" });
    await createReport(program, researcher, {
      title: `${tag} a`,
      status: "TRIAGING",
      severity: "HIGH",
    });
    await createReport(program, researcher, { title: `${tag} b`, status: "NEW" });
    await createReport(p2, researcher, { title: `${tag} c`, status: "TRIAGING", severity: "LOW" });
    const q = (extra: string) =>
      api()
        .get(`${API}/reports?search=${encodeURIComponent(tag)}${extra}`)
        .set(bearer(admin));

    expect((await q("&status=TRIAGING")).body.meta.total).toBe(2);
    expect((await q("&severity=HIGH")).body.meta.total).toBe(1);
    expect((await q(`&programId=${p2.id}`)).body.meta.total).toBe(1);
    const sorted = await q("&sortBy=title&order=asc&limit=2&page=1");
    expect(sorted.body.data.map((r: any) => r.title.slice(-1))).toEqual(["a", "b"]);
    expect(sorted.body.meta).toMatchObject({ total: 3, totalPages: 2 });
    for (const bad of ["status=NOPE", "severity=EXTREME", "programId=x", "sortBy=description"]) {
      expectError(await api().get(`${API}/reports?${bad}`).set(bearer(admin)), 422);
    }
  });

  it("leaves out soft-deleted reports", async () => {
    const gone = await createReport(program, researcher);
    await prisma.report.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });
    expectError(await get(gone.id, researcher), 404);
  });
});

describe("PATCH and DELETE /reports/:id (researcher)", () => {
  it("lets the author edit while NEW, keeping the status", async () => {
    const report = await createReport(program, researcher);
    const res = await api()
      .patch(`${API}/reports/${report.id}`)
      .set(bearer(researcher))
      .send({ title: `${TAG} Edited title` });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: `${TAG} Edited title`, status: "NEW" });
  });

  it("returns 404 to another researcher and 403 to an owner", async () => {
    const report = await createReport(program, researcher);
    const edit = (u: User) =>
      api().patch(`${API}/reports/${report.id}`).set(bearer(u)).send({ title: "Hijacked report" });
    expectError(await edit(otherResearcher), 404);
    expectError(await edit(owner), 403);
    expectError(await edit(admin), 403);
  });

  it.each([
    ["severity", { severity: "LOW" }],
    ["status", { status: "ACCEPTED" }],
    ["programId", { programId: NIL_UUID }],
  ])("does not let the author change %s", async (_field, extra) => {
    const report = await createReport(program, researcher);
    expectError(
      await api().patch(`${API}/reports/${report.id}`).set(bearer(researcher)).send(extra),
      422,
    );
  });

  it("rejects an empty update", async () => {
    const report = await createReport(program, researcher);
    expectError(
      await api().patch(`${API}/reports/${report.id}`).set(bearer(researcher)).send({}),
      422,
    );
  });

  it.each(["TRIAGING", "ACCEPTED", "REJECTED", "DUPLICATE", "REWARDED"] as const)(
    "locks the report once it is %s",
    async (status) => {
      const report = await createReport(program, researcher, { status, severity: "LOW" });
      const edit = await api()
        .patch(`${API}/reports/${report.id}`)
        .set(bearer(researcher))
        .send({ title: "Too late to edit" });
      const del = await api().delete(`${API}/reports/${report.id}`).set(bearer(researcher));
      expectError(edit, 409);
      expectError(del, 409);
    },
  );

  it("sends a NEEDS_INFO report back to triage when the researcher answers", async () => {
    const report = await createReport(program, researcher, { status: "NEEDS_INFO" });
    const res = await api()
      .patch(`${API}/reports/${report.id}`)
      .set(bearer(researcher))
      .send({ description: "Now with full reproduction steps included." });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("TRIAGING");

    const trail = await auditOf(report.id);
    expect(trail).toEqual([
      expect.objectContaining({
        action: "REPORT_STATUS_CHANGE",
        actorId: researcher.id,
        metadata: { from: "NEEDS_INFO", to: "TRIAGING", reason: "researcher_update" },
      }),
    ]);
  });

  it("soft-deletes on withdrawal, with an audit row", async () => {
    const report = await createReport(program, researcher);
    expect((await api().delete(`${API}/reports/${report.id}`).set(bearer(researcher))).status).toBe(
      200,
    );
    expectError(await get(report.id, researcher), 404);
    expect(
      (await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).deletedAt,
    ).not.toBeNull();
    expect((await auditOf(report.id)).map((a) => a.action)).toEqual(["REPORT_DELETED"]);
  });

  it("returns 404 when someone else tries to withdraw", async () => {
    const report = await createReport(program, researcher);
    expectError(
      await api().delete(`${API}/reports/${report.id}`).set(bearer(otherResearcher)),
      404,
    );
  });
});

describe("PATCH /reports/:id/status (triage)", () => {
  it("walks NEW -> TRIAGING -> NEEDS_INFO -> TRIAGING -> ACCEPTED with an audit trail", async () => {
    const report = await createReport(program, researcher);
    expect((await triage(report.id, { status: "TRIAGING", note: "picked up" })).status).toBe(200);
    expect((await triage(report.id, { status: "NEEDS_INFO", note: "need repro" })).status).toBe(
      200,
    );
    await api()
      .patch(`${API}/reports/${report.id}`)
      .set(bearer(researcher))
      .send({ description: "Reproduction steps added in full detail." });
    const accepted = await triage(report.id, { status: "ACCEPTED", severity: "HIGH" });
    expect(accepted.status).toBe(200);
    expect(accepted.body.data).toMatchObject({ status: "ACCEPTED", severity: "HIGH" });

    const trail = await auditOf(report.id);
    expect(trail.map((a) => `${a.metadata?.from}>${a.metadata?.to}`)).toEqual([
      "NEW>TRIAGING",
      "TRIAGING>NEEDS_INFO",
      "NEEDS_INFO>TRIAGING",
      "TRIAGING>ACCEPTED",
    ]);
    expect(trail[0].metadata?.note).toBe("picked up");
    expect(trail[0].actorId).toBe(admin.id);
    expect(trail[2].actorId).toBe(researcher.id);
  });

  it("is admin-only", async () => {
    const report = await createReport(program, researcher);
    expectError(await triage(report.id, { status: "TRIAGING" }, owner), 403);
    expectError(await triage(report.id, { status: "TRIAGING" }, researcher), 403);
  });

  it.each([
    ["NEW", "ACCEPTED"],
    ["NEW", "NEEDS_INFO"],
    ["NEEDS_INFO", "ACCEPTED"],
    ["ACCEPTED", "REJECTED"],
    ["ACCEPTED", "TRIAGING"],
    ["REJECTED", "TRIAGING"],
    ["DUPLICATE", "TRIAGING"],
    ["REWARDED", "TRIAGING"],
  ] as const)("returns 409 for %s -> %s", async (from, to) => {
    const report = await createReport(program, researcher, { status: from, severity: "HIGH" });
    expectError(await triage(report.id, { status: to, severity: "HIGH" }), 409, {
      message: /cannot change report status/i,
    });
    expect((await prisma.report.findUniqueOrThrow({ where: { id: report.id } })).status).toBe(from);
  });

  it("does not allow REWARDED through this endpoint", async () => {
    const report = await createReport(program, researcher, {
      status: "ACCEPTED",
      severity: "HIGH",
    });
    expectError(await triage(report.id, { status: "REWARDED" }), 422);
  });

  it("needs a severity to accept, either sent or already set", async () => {
    const bare = await createReport(program, researcher, { status: "TRIAGING" });
    expectError(await triage(bare.id, { status: "ACCEPTED" }), 422, {
      message: /severity is required/i,
    });

    const preset = await createReport(program, researcher, {
      status: "TRIAGING",
      severity: "MEDIUM",
    });
    const res = await triage(preset.id, { status: "ACCEPTED" });
    expect(res.status).toBe(200);
    expect(res.body.data.severity).toBe("MEDIUM");
  });

  it("will not accept a severity the program has no reward tier for", async () => {
    const noTiers = await createProgram(owner, { status: "ACTIVE", tiers: { LOW: 100 } });
    const report = await createReport(noTiers, researcher, { status: "TRIAGING" });
    expectError(await triage(report.id, { status: "ACCEPTED", severity: "CRITICAL" }), 409, {
      message: /no reward tier/i,
    });
  });

  it("only overrides the severity when one is sent", async () => {
    const report = await createReport(program, researcher, { status: "NEW", severity: "LOW" });
    const res = await triage(report.id, { status: "TRIAGING", severity: "CRITICAL" });
    expect(res.body.data.severity).toBe("CRITICAL");
  });

  describe("duplicates", () => {
    it("links the duplicate to the original", async () => {
      const original = await createReport(program, researcher, { status: "TRIAGING" });
      const dup = await createReport(program, otherResearcher, { status: "TRIAGING" });
      const res = await triage(dup.id, { status: "DUPLICATE", duplicateOfId: original.id });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: "DUPLICATE", duplicateOfId: original.id });
    });

    it("requires duplicateOfId for DUPLICATE and forbids it otherwise", async () => {
      const report = await createReport(program, researcher, { status: "TRIAGING" });
      expectError(await triage(report.id, { status: "DUPLICATE" }), 422);
      expectError(await triage(report.id, { status: "REJECTED", duplicateOfId: NIL_UUID }), 422);
    });

    it("rejects a report duplicating itself, a missing original, or another program's report", async () => {
      const report = await createReport(program, researcher, { status: "TRIAGING" });
      const elsewhere = await createReport(await createProgram(owner), researcher);
      expectError(await triage(report.id, { status: "DUPLICATE", duplicateOfId: report.id }), 422);
      expectError(await triage(report.id, { status: "DUPLICATE", duplicateOfId: NIL_UUID }), 422);
      expectError(
        await triage(report.id, { status: "DUPLICATE", duplicateOfId: elsewhere.id }),
        422,
      );
    });

    it("does not allow a chain of duplicates", async () => {
      const original = await createReport(program, researcher, { status: "TRIAGING" });
      const first = await createReport(program, researcher, { status: "TRIAGING" });
      const second = await createReport(program, researcher, { status: "TRIAGING" });
      await triage(first.id, { status: "DUPLICATE", duplicateOfId: original.id });
      expectError(await triage(second.id, { status: "DUPLICATE", duplicateOfId: first.id }), 422);
    });
  });

  it("returns 404 for an unknown report and 422 for a bad status", async () => {
    expectError(await triage(NIL_UUID, { status: "TRIAGING" }), 404);
    const report = await createReport(program, researcher);
    expectError(await triage(report.id, { status: "BOGUS" }), 422);
    expectError(await triage(report.id, { status: "TRIAGING", extra: 1 }), 422);
  });

  it("lets only one of several simultaneous triage calls win", async () => {
    const report = await createReport(program, researcher, { status: "NEW" });
    const results = await Promise.all([
      triage(report.id, { status: "TRIAGING" }),
      triage(report.id, { status: "TRIAGING" }),
      triage(report.id, { status: "TRIAGING" }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await auditOf(report.id)).toHaveLength(1);
  });
});

describe("report comments", () => {
  let report: Awaited<ReturnType<typeof createReport>>;
  const comment = (u: User, text: unknown, id = report.id) =>
    api().post(`${API}/reports/${id}/comments`).set(bearer(u)).send({ body: text });

  beforeAll(async () => {
    report = await createReport(program, researcher);
  });

  it("lets the author, the program owner, and an admin comment", async () => {
    for (const u of [researcher, admin, owner]) {
      const res = await comment(u, `Comment from ${u.role}`);
      expect(res.status).toBe(201);
      expect(res.body.data.author).toMatchObject({ id: u.id, role: u.role });
    }
  });

  it("returns 404 to people who cannot see the report", async () => {
    expectError(await comment(otherResearcher, "hello"), 404);
    expectError(await comment(otherOwner, "hello"), 404);
    expectError(await comment(admin, "hello", NIL_UUID), 404);
  });

  it("lists comments oldest first, and paginates", async () => {
    const res = await api().get(`${API}/reports/${report.id}/comments`).set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.data.map((c: any) => c.author.role)).toEqual([
      "RESEARCHER",
      "ADMIN",
      "PROGRAM_OWNER",
    ]);

    const page = await api()
      .get(`${API}/reports/${report.id}/comments?limit=2&page=2`)
      .set(bearer(admin));
    expect(page.body.data).toHaveLength(1);
    expect(page.body.meta).toMatchObject({ total: 3, totalPages: 2 });
  });

  it("hides the thread from people who cannot see the report", async () => {
    expectError(
      await api().get(`${API}/reports/${report.id}/comments`).set(bearer(otherResearcher)),
      404,
    );
  });

  it.each([
    ["an empty body", "   "],
    ["a body over 5000 characters", "x".repeat(5001)],
    ["a non-string body", 42],
  ])("rejects %s", async (_label, text) => {
    expectError(await comment(researcher, text), 422);
  });

  it("rejects extra fields, so the author cannot be spoofed", async () => {
    const res = await api()
      .post(`${API}/reports/${report.id}/comments`)
      .set(bearer(researcher))
      .send({ body: "hello there", authorId: admin.id });
    expectError(res, 422);
  });

  it("still allows comments on a finished report", async () => {
    const done = await createReport(program, researcher, { status: "REJECTED" });
    expect((await comment(admin, "Closing note", done.id)).status).toBe(201);
  });
});
