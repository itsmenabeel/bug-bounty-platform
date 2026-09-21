import type { RequestHandler } from "express";
import rateLimit, { ipKeyGenerator, type Options } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import { env } from "../config/env";
import { redis } from "../config/redis";
import { AUTH_LIMIT, GLOBAL_LIMIT, REPORT_SUBMIT_LIMIT } from "../shared/constants/rateLimit";
import { AppError } from "../shared/errors/AppError";

type Tier = { windowMs: number; limit: number };

/**
 * The store is chosen on the first request, once the server has tried to connect to
 * Redis. Counters then survive restarts and are shared across instances. If Redis
 * is not available, the limiter counts in memory. If Redis fails later,
 * passOnStoreError lets requests through instead of blocking them.
 */
function createLimiter(name: string, tier: Tier, extra: Partial<Options> = {}): RequestHandler {
  let limiter: RequestHandler | undefined;

  return (req, res, next) => {
    if (!env.RATE_LIMIT_ENABLED) return next();

    const client = redis?.status === "ready" ? redis : null;
    limiter ??= rateLimit({
      ...tier,
      standardHeaders: true,
      legacyHeaders: false,
      passOnStoreError: true,
      handler: (_req, _res, done) =>
        done(new AppError(429, "Too many requests, please try again later")),
      ...(client && {
        store: new RedisStore({
          prefix: `rl:${name}:`,
          sendCommand: (command: string, ...args: string[]) =>
            client.call(command, ...args) as Promise<never>,
        }),
      }),
      ...extra,
    });
    limiter(req, res, next);
  };
}

export const globalLimiter = createLimiter("global", GLOBAL_LIMIT, {
  skip: (req) => req.originalUrl.startsWith("/api/v1/payments/webhook"),
});

export const authLimiter = createLimiter("auth", AUTH_LIMIT);

export const reportSubmitLimiter = createLimiter("report-submit", REPORT_SUBMIT_LIMIT, {
  keyGenerator: (req) => req.user?.id ?? ipKeyGenerator(req.ip ?? ""),
});
