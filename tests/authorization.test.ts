import type { Role } from "@prisma/client";
import jwt from "jsonwebtoken";
import { env } from "../src/config/env";
import { prisma } from "../src/config/prisma";
import { signAccessToken } from "../src/shared/utils/jwt";
import { API, api, bearer, expectError, NIL_UUID } from "./helpers/api";
import { createUser, purge } from "./helpers/factory";

afterAll(purge);

describe("authenticate", () => {
  it("requires a bearer token", async () => {
    expectError(await api().get(`${API}/users/me`), 401, { message: /authentication required/i });
  });

  it("rejects a non-Bearer scheme", async () => {
    const user = await createUser();
    expectError(
      await api().get(`${API}/users/me`).set("Authorization", `Basic ${user.token}`),
      401,
    );
  });

  it("rejects an empty bearer value", async () => {
    expectError(await api().get(`${API}/users/me`).set("Authorization", "Bearer "), 401);
  });

  it("rejects a garbage token", async () => {
    const res = await api().get(`${API}/users/me`).set("Authorization", "Bearer abc.def.ghi");
    expectError(res, 401, { message: /invalid or expired/i });
  });

  it("rejects an expired token", async () => {
    const user = await createUser();
    const expired = jwt.sign({ sub: user.id, role: user.role }, env.JWT_ACCESS_SECRET, {
      expiresIn: -60,
    });
    expectError(await api().get(`${API}/users/me`).set("Authorization", `Bearer ${expired}`), 401);
  });

  it("rejects a token signed with the wrong secret", async () => {
    const user = await createUser();
    const forged = jwt.sign(
      { sub: user.id, role: "ADMIN" },
      "attacker-secret-attacker-secret-1234",
    );
    expectError(await api().get(`${API}/users/me`).set("Authorization", `Bearer ${forged}`), 401);
  });

  it("rejects a token for a user that does not exist", async () => {
    const ghost = signAccessToken({ sub: NIL_UUID, role: "ADMIN" });
    expectError(await api().get(`${API}/users/me`).set("Authorization", `Bearer ${ghost}`), 401);
  });

  it("rejects a banned user immediately, even with a valid token", async () => {
    const user = await createUser();
    expect((await api().get(`${API}/users/me`).set(bearer(user))).status).toBe(200);
    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expectError(await api().get(`${API}/users/me`).set(bearer(user)), 401);
  });

  it("rejects a soft-deleted user", async () => {
    const user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });
    expectError(await api().get(`${API}/users/me`).set(bearer(user)), 401);
  });

  it("uses the role in the database, not the role claimed by the token", async () => {
    const user = await createUser("RESEARCHER");
    const claimsAdmin = { token: signAccessToken({ sub: user.id, role: "ADMIN" }) };
    expectError(await api().get(`${API}/admin/users`).set(bearer(claimsAdmin)), 403);

    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });
    expect((await api().get(`${API}/admin/users`).set(bearer(claimsAdmin))).status).toBe(200);
  });
});

// Each row names the roles that may call the route. Every other role must get 403.
// authorize runs before validation, so an empty body is enough to reach the role check.
const ROUTES: {
  method: "get" | "post" | "put" | "patch" | "delete";
  path: string;
  allowed: Role[];
}[] = [
  { method: "post", path: "/programs", allowed: ["PROGRAM_OWNER"] },
  { method: "patch", path: `/programs/${NIL_UUID}`, allowed: ["PROGRAM_OWNER"] },
  { method: "patch", path: `/programs/${NIL_UUID}/status`, allowed: ["PROGRAM_OWNER"] },
  { method: "put", path: `/programs/${NIL_UUID}/reward-tiers`, allowed: ["PROGRAM_OWNER"] },
  { method: "delete", path: `/programs/${NIL_UUID}`, allowed: ["PROGRAM_OWNER"] },
  { method: "post", path: "/reports", allowed: ["RESEARCHER"] },
  { method: "patch", path: `/reports/${NIL_UUID}`, allowed: ["RESEARCHER"] },
  { method: "delete", path: `/reports/${NIL_UUID}`, allowed: ["RESEARCHER"] },
  { method: "patch", path: `/reports/${NIL_UUID}/status`, allowed: ["ADMIN"] },
  { method: "post", path: `/reports/${NIL_UUID}/reward`, allowed: ["ADMIN"] },
  { method: "post", path: "/payments/checkout", allowed: ["PROGRAM_OWNER"] },
  { method: "get", path: "/payments", allowed: ["PROGRAM_OWNER", "ADMIN"] },
  { method: "get", path: `/payments/${NIL_UUID}`, allowed: ["PROGRAM_OWNER", "ADMIN"] },
  { method: "post", path: `/payments/${NIL_UUID}/verify`, allowed: ["PROGRAM_OWNER", "ADMIN"] },
  { method: "get", path: "/admin/users", allowed: ["ADMIN"] },
  { method: "patch", path: `/admin/users/${NIL_UUID}/role`, allowed: ["ADMIN"] },
  { method: "patch", path: `/admin/users/${NIL_UUID}/status`, allowed: ["ADMIN"] },
  { method: "get", path: "/admin/audit-logs", allowed: ["ADMIN"] },
  { method: "get", path: "/admin/dashboard-stats", allowed: ["ADMIN"] },
];

describe("role-based access control", () => {
  const users = {} as Record<Role, Awaited<ReturnType<typeof createUser>>>;

  beforeAll(async () => {
    for (const role of ["RESEARCHER", "PROGRAM_OWNER", "ADMIN"] as const) {
      users[role] = await createUser(role);
    }
  });

  it.each(ROUTES)(
    "$method $path rejects an anonymous caller with 401",
    async ({ method, path }) => {
      expectError(await api()[method](API + path), 401);
    },
  );

  it.each(
    ROUTES.flatMap((route) =>
      (["RESEARCHER", "PROGRAM_OWNER", "ADMIN"] as const)
        .filter((role) => !route.allowed.includes(role))
        .map((role) => ({ ...route, role })),
    ),
  )("$method $path returns 403 for $role", async ({ method, path, role }) => {
    expectError(
      await api()
        [method](API + path)
        .set(bearer(users[role])),
      403,
      {
        message: /permission/i,
      },
    );
  });

  it.each(["GET /programs", "GET /reports", "GET /payouts", "GET /users/me"])(
    "%s is open to every signed-in role",
    async (route) => {
      const path = route.split(" ")[1];
      for (const role of ["RESEARCHER", "PROGRAM_OWNER", "ADMIN"] as const) {
        expect(
          (
            await api()
              .get(API + path)
              .set(bearer(users[role]))
          ).status,
        ).toBe(200);
      }
    },
  );
});
