import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";
import { AppError } from "../../src/shared/errors/AppError";
import { clientKey } from "../../src/shared/utils/clientKey";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../src/shared/utils/jwt";
import { hashPassword, verifyPassword } from "../../src/shared/utils/password";
import { claimToken } from "../../src/shared/utils/tokenDenylist";

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("Correct1Horse");
    expect(hash).not.toContain("Correct1Horse");
    expect(await verifyPassword("Correct1Horse", hash)).toBe(true);
    expect(await verifyPassword("correct1horse", hash)).toBe(false);
  });

  it("salts each hash", async () => {
    expect(await hashPassword("SamePass1")).not.toBe(await hashPassword("SamePass1"));
  });
});

describe("jwt", () => {
  it("round-trips an access token", () => {
    const token = signAccessToken({ sub: "user-1", role: "ADMIN" });
    expect(verifyAccessToken(token)).toMatchObject({ sub: "user-1", role: "ADMIN" });
  });

  it("gives every refresh token a unique jti", () => {
    const first = verifyRefreshToken(signRefreshToken("user-1"));
    const second = verifyRefreshToken(signRefreshToken("user-1"));
    expect(first.jti).not.toBe(second.jti);
    expect(first.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it("does not accept one token type as the other", () => {
    expect(() => verifyAccessToken(signRefreshToken("user-1"))).toThrow(AppError);
    expect(() => verifyRefreshToken(signAccessToken({ sub: "user-1", role: "ADMIN" }))).toThrow(
      AppError,
    );
  });

  it("rejects an expired token with a 401", () => {
    const expired = jwt.sign({ sub: "user-1", role: "ADMIN" }, env.JWT_ACCESS_SECRET, {
      expiresIn: -10,
    });
    try {
      verifyAccessToken(expired);
      throw new Error("expected a throw");
    } catch (error) {
      expect((error as AppError).statusCode).toBe(401);
    }
  });

  it("rejects a token signed with another secret", () => {
    const forged = jwt.sign({ sub: "user-1", role: "ADMIN" }, "some-other-secret-value-1234567890");
    expect(() => verifyAccessToken(forged)).toThrow(AppError);
  });

  it("rejects an alg=none token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ sub: "user-1", role: "ADMIN" })).toString(
      "base64url",
    );
    expect(() => verifyAccessToken(`${header}.${body}.`)).toThrow(AppError);
  });

  it("rejects a refresh token missing its jti", () => {
    const noJti = jwt.sign({ sub: "user-1" }, env.JWT_REFRESH_SECRET, { expiresIn: "1h" });
    expect(() => verifyRefreshToken(noJti)).toThrow(AppError);
  });
});

describe("refresh token denylist (in-memory fallback)", () => {
  const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

  it("lets only the first caller claim a token", async () => {
    const jti = randomUUID();
    expect(await claimToken(jti, inAnHour())).toBe(true);
    expect(await claimToken(jti, inAnHour())).toBe(false);
  });

  it("lets concurrent callers claim once", async () => {
    const jti = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimToken(jti, inAnHour())),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("tracks tokens independently", async () => {
    expect(await claimToken(randomUUID(), inAnHour())).toBe(true);
    expect(await claimToken(randomUUID(), inAnHour())).toBe(true);
  });
});

describe("clientKey", () => {
  const secret = env.BFF_SHARED_SECRET as string;
  const fakeRequest = (headers: Record<string, string>, ip = "198.51.100.1") =>
    ({ ip, get: (name: string) => headers[name.toLowerCase()] }) as unknown as Request;

  afterEach(() => {
    env.BFF_SHARED_SECRET = secret;
  });

  it("uses the visitor IP when the secret matches", () => {
    const req = fakeRequest({ "x-bff-secret": secret, "x-client-ip": "203.0.113.7" });
    expect(clientKey(req)).toBe("203.0.113.7");
  });

  it("groups a visitor's IPv6 address by /56", () => {
    const key = (ip: string) =>
      clientKey(fakeRequest({ "x-bff-secret": secret, "x-client-ip": ip }));
    expect(key("2001:db8:1:2::1")).toBe(ipKeyGenerator("2001:db8:1:2::1"));
    expect(key("2001:db8:1:2::1")).toBe(key("2001:db8:1:3::9"));
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:2:2::1"));
  });

  it("falls back to req.ip for a wrong secret of a different length", () => {
    const req = fakeRequest({ "x-bff-secret": "short", "x-client-ip": "203.0.113.7" });
    expect(clientKey(req)).toBe("198.51.100.1");
  });

  it("falls back to req.ip when no secret is configured", () => {
    env.BFF_SHARED_SECRET = undefined;
    const req = fakeRequest({ "x-bff-secret": secret, "x-client-ip": "203.0.113.7" });
    expect(clientKey(req)).toBe("198.51.100.1");
  });
});
