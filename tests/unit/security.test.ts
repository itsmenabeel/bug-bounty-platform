import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { env } from "../../src/config/env";
import { AppError } from "../../src/shared/errors/AppError";
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
