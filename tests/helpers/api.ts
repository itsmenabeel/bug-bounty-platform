import request from "supertest";
import { app } from "../../src/app";

export const api = () => request(app);
export const API = "/api/v1";
export const bearer = (user: { token: string }) => ({ Authorization: `Bearer ${user.token}` });

export const NIL_UUID = "00000000-0000-4000-8000-000000000000";

type ErrorResponse = {
  status: number;
  body: { success?: boolean; message?: string; errors?: unknown };
};

/** Asserts the standard error envelope, and optionally the status, message, and error code. */
export function expectError(
  res: ErrorResponse,
  status: number,
  extra: { message?: string | RegExp; code?: string } = {},
) {
  expect(res.status).toBe(status);
  expect(res.body.success).toBe(false);
  expect(typeof res.body.message).toBe("string");
  expect(Array.isArray(res.body.errors)).toBe(true);
  if (extra.message) expect(res.body.message).toMatch(extra.message);
  if (extra.code) expect(res.body.errors).toEqual([{ code: extra.code }]);
}
