import { createHash } from "node:crypto";
import { redis } from "../../config/redis";

export type CacheStatus = "HIT" | "MISS" | "BYPASS";

const readyClient = () => (redis?.status === "ready" ? redis : null);

const versionKey = (namespace: string) => `cache:${namespace}:version`;

/**
 * Read-through cache in Redis. Keys embed a per-namespace version, so invalidate()
 * retires every entry at once with a single INCR and no key scan. Stale keys expire
 * on their own. Without Redis, or on any Redis error, the loader runs directly.
 * Cached values pass through JSON, so Dates come back as ISO strings, which is
 * how the response serializes them anyway.
 */
export async function cached<T>(
  namespace: string,
  keyParts: unknown,
  ttlSeconds: number,
  load: () => Promise<T>,
): Promise<{ value: T; status: CacheStatus }> {
  const client = readyClient();
  if (!client) return { value: await load(), status: "BYPASS" };

  let key = "";
  try {
    // The version is read before loading, so a write during the load leaves this
    // entry under the old version, where nothing will read it.
    const version = (await client.get(versionKey(namespace))) ?? "0";
    const digest = createHash("sha1").update(JSON.stringify(keyParts)).digest("hex");
    key = `cache:${namespace}:v${version}:${digest}`;

    const hit = await client.get(key);
    if (hit) return { value: JSON.parse(hit) as T, status: "HIT" };
  } catch {
    return { value: await load(), status: "BYPASS" };
  }

  const value = await load();
  client.set(key, JSON.stringify(value), "EX", ttlSeconds).catch(() => {});
  return { value, status: "MISS" };
}

/** Call after a write commits. A Redis failure never fails the request. */
export async function invalidate(namespace: string) {
  const client = readyClient();
  if (!client) return;
  try {
    await client.incr(versionKey(namespace));
  } catch (error) {
    console.error("Cache invalidation failed:", error);
  }
}
