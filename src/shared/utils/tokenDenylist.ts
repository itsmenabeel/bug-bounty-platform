import { redis } from "../../config/redis";

const KEY_PREFIX = "denylist:";
const memory = new Map<string, number>();

// Fallback store for when Redis is unset or down. Entries do not survive a restart.
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of memory) if (expiresAt <= now) memory.delete(jti);
}, 60_000).unref();

/**
 * Marks a refresh token as used. Resolves true only for the first caller, so
 * concurrent refreshes with the same token cannot both succeed.
 */
export async function claimToken(jti: string, expSeconds: number): Promise<boolean> {
  const ttl = Math.max(1, expSeconds - Math.floor(Date.now() / 1000));

  if (redis?.status === "ready") {
    try {
      return (await redis.set(KEY_PREFIX + jti, "1", "EX", ttl, "NX")) === "OK";
    } catch {
      // Redis failed mid-request; fall through to memory.
    }
  }

  const expiresAt = memory.get(jti);
  if (expiresAt && expiresAt > Date.now()) return false;
  memory.set(jti, Date.now() + ttl * 1000);
  return true;
}
