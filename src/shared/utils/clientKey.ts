import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";
import { env } from "../../config/env";
import { BFF_SECRET_HEADER, CLIENT_IP_HEADER } from "../constants/http";

function fromFrontendServer(req: Request) {
  const secret = env.BFF_SHARED_SECRET;
  const sent = req.get(BFF_SECRET_HEADER);
  if (!secret || !sent) return false;
  const expected = Buffer.from(secret);
  const received = Buffer.from(sent);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

/**
 * Rate-limit key for a request. The frontend server makes calls on behalf of its
 * visitors, so they all arrive from its IP. When it proves itself with the shared
 * secret, the visitor's IP in X-Client-IP becomes the key. Any other caller is
 * keyed on req.ip, so a forged header gains nothing.
 */
export function clientKey(req: Request) {
  const visitorIp = req.get(CLIENT_IP_HEADER)?.trim();
  if (visitorIp && isIP(visitorIp) && fromFrontendServer(req)) {
    return ipKeyGenerator(visitorIp);
  }
  return ipKeyGenerator(req.ip ?? "");
}
