import { DEFAULT_LIMIT, MAX_LIMIT } from "../../src/shared/constants/pagination";
import { applyPagination, buildMeta, paginationQuery } from "../../src/shared/utils/pagination";

const schema = paginationQuery(["createdAt", "title"], "createdAt");

describe("paginationQuery", () => {
  it("applies defaults", () => {
    expect(schema.parse({})).toEqual({
      page: 1,
      limit: DEFAULT_LIMIT,
      sortBy: "createdAt",
      order: "desc",
    });
  });

  it("coerces numeric strings from the query string", () => {
    expect(schema.parse({ page: "3", limit: "25" })).toMatchObject({ page: 3, limit: 25 });
  });

  it("honours a custom default order", () => {
    expect(paginationQuery(["createdAt"], "createdAt", "asc").parse({}).order).toBe("asc");
  });

  it.each([
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { limit: "0" },
    { limit: String(MAX_LIMIT + 1) },
    { limit: "abc" },
    { order: "sideways" },
    { sortBy: "passwordHash" },
  ])("rejects %j", (query) => {
    expect(schema.safeParse(query).success).toBe(false);
  });

  it("accepts the maximum limit", () => {
    expect(schema.safeParse({ limit: String(MAX_LIMIT) }).success).toBe(true);
  });
});

describe("applyPagination", () => {
  it("converts page and limit to skip and take", () => {
    expect(applyPagination({ page: 1, limit: 10, sortBy: "title", order: "asc" })).toEqual({
      skip: 0,
      take: 10,
      orderBy: { title: "asc" },
    });
    expect(applyPagination({ page: 4, limit: 25, sortBy: "createdAt", order: "desc" })).toEqual({
      skip: 75,
      take: 25,
      orderBy: { createdAt: "desc" },
    });
  });
});

describe("buildMeta", () => {
  it("rounds total pages up", () => {
    expect(buildMeta(1, 10, 25)).toEqual({ page: 1, limit: 10, total: 25, totalPages: 3 });
    expect(buildMeta(1, 10, 30).totalPages).toBe(3);
  });

  it("reports zero pages for an empty result", () => {
    expect(buildMeta(1, 10, 0).totalPages).toBe(0);
  });
});
