import { prisma } from "../src/config/prisma";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createProgram, createUser, purge, TAG } from "./helpers/factory";

type User = Awaited<ReturnType<typeof createUser>>;
let owner: User;
let researcher: User;
const ids: Record<string, string> = {};

const list = (query = "") =>
  api().get(`${API}/public/programs?search=${encodeURIComponent(TAG)}${query}`);
const titles = (res: { body: { data: { title: string }[] } }) =>
  res.body.data.map((p) => p.title.replace(`${TAG} `, ""));

beforeAll(async () => {
  [owner, researcher] = await Promise.all([
    createUser("PROGRAM_OWNER", { name: "Public Owner Co" }),
    createUser("RESEARCHER"),
  ]);
  const make = async (name: string, status: "ACTIVE" | "DRAFT" | "PAUSED" | "CLOSED", pool = 0) => {
    const p = await createProgram(owner, { title: `${TAG} ${name}`, status, poolBalance: pool });
    ids[name] = p.id;
  };
  await make("Alpha", "ACTIVE", 500);
  await make("Bravo", "ACTIVE", 900);
  await make("Charlie", "ACTIVE", 100);
  await make("Delta", "DRAFT");
  await make("Echo", "PAUSED");
  await make("Foxtrot", "CLOSED");
  await make("Golf", "ACTIVE");
  await prisma.program.update({ where: { id: ids.Golf }, data: { deletedAt: new Date() } });
});
afterAll(purge);

describe("GET /public/programs", () => {
  it("lists only live ACTIVE programs without a token", async () => {
    const res = await list("&sortBy=title&order=asc");
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(["Alpha", "Bravo", "Charlie"]);
  });

  it("ignores status and mine", async () => {
    expect(titles(await list("&status=DRAFT&sortBy=title&order=asc"))).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
    expect(titles(await list("&mine=true&sortBy=title&order=asc"))).toEqual([
      "Alpha",
      "Bravo",
      "Charlie",
    ]);
  });

  it("sorts, paginates, and reports meta the same as the signed-in list", async () => {
    for (const query of [
      "&sortBy=title&order=desc",
      "&sortBy=poolBalance&order=desc",
      "&limit=2&page=2&sortBy=title&order=asc",
    ]) {
      const [open, signedIn] = await Promise.all([
        list(query),
        api()
          .get(`${API}/programs?search=${encodeURIComponent(TAG)}${query}`)
          .set(bearer(researcher)),
      ]);
      expect(titles(open)).toEqual(titles(signedIn));
      expect(open.body.meta).toEqual(signedIn.body.meta);
    }
    expect(titles(await list("&sortBy=poolBalance&order=desc"))).toEqual([
      "Bravo",
      "Alpha",
      "Charlie",
    ]);
  });

  it.each([["limit=51"], ["sortBy=ownerId"], ["order=sideways"]])(
    "returns 422 for %s",
    async (query) => {
      expectError(await api().get(`${API}/public/programs?${query}`), 422);
    },
  );

  it("includes tiers, scope, and the owner's name, but not deletedAt", async () => {
    const res = await list();
    for (const program of res.body.data) {
      expect(program.rewardTiers.length).toBeGreaterThan(0);
      expect(program.scope).toEqual({ inScope: ["app.test"], outOfScope: [] });
      expect(program.owner).toEqual({ name: "Public Owner Co" });
      expect(program).not.toHaveProperty("deletedAt");
    }
  });
});

describe("GET /public/programs/:id", () => {
  it("returns an ACTIVE program without a token", async () => {
    const res = await api().get(`${API}/public/programs/${ids.Alpha}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: ids.Alpha, owner: { name: "Public Owner Co" } });
  });

  it.each([["Delta"], ["Echo"], ["Foxtrot"], ["Golf"]])("returns 404 for %s", async (name) => {
    expectError(await api().get(`${API}/public/programs/${ids[name]}`), 404);
  });

  it("returns 404 for an unknown id and 422 for a malformed one", async () => {
    expectError(await api().get(`${API}/public/programs/${NIL_UUID}`), 404);
    expectError(await api().get(`${API}/public/programs/not-a-uuid`), 422);
  });
});

describe("GET /public/stats", () => {
  it("returns platform totals without a token", async () => {
    const res = await api().get(`${API}/public/stats`);
    expect(res.status).toBe(200);
    const { generatedAt, ...counts } = res.body.data;
    expect(Object.keys(counts).sort()).toEqual([
      "activePrograms",
      "availableInPools",
      "payoutCount",
      "reportsResolved",
      "researchers",
      "totalPaidOut",
    ]);
    for (const value of Object.values(counts)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(Number.isNaN(Date.parse(generatedAt))).toBe(false);
    // Tests run without Redis, so the counts are live.
    expect(counts.activePrograms).toBeGreaterThanOrEqual(3);
    expect(counts.availableInPools).toBeGreaterThanOrEqual(1500);
    expect(counts.researchers).toBeGreaterThanOrEqual(1);
  });
});

describe("signed-in routes", () => {
  it("still require a token for /programs", async () => {
    expectError(await api().get(`${API}/programs`), 401);
    expectError(await api().get(`${API}/programs/${ids.Alpha}`), 401);
  });
});
