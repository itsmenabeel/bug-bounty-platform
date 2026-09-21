import Redis from "ioredis";
import { env } from "./env";

// Null when REDIS_URL is unset; callers fall back to in-memory behaviour.
export const redis: Redis | null = env.REDIS_URL
  ? new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      // Fail fast during an outage so callers fall back instead of hanging.
      enableOfflineQueue: false,
    })
  : null;

redis?.on("error", (error) => console.error("Redis error:", error.message));
