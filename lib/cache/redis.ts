import { Redis } from "@upstash/redis";

let _redis: Redis | null = null;

export function redis(): Redis {
  if (_redis) return _redis;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing Redis credentials. Expected KV_REST_API_URL/KV_REST_API_TOKEN (Vercel Marketplace) or UPSTASH_REDIS_REST_URL/TOKEN.",
    );
  }
  _redis = new Redis({ url, token });
  return _redis;
}

export async function cacheJson<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
): Promise<T> {
  const r = redis();
  const cached = await r.get<T>(key);
  if (cached !== null && cached !== undefined) return cached;
  const fresh = await loader();
  await r.set(key, fresh, { ex: ttlSeconds });
  return fresh;
}
