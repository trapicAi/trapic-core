/**
 * Team access helper with caching.
 * Wraps DbAdapter.getVisibleAuthorIds() with in-memory TTL cache.
 *
 * Note: team membership for visibility checks is now done INSIDE DB RPCs
 * (ROOT-FIX), not client-side. getCallerTeamIds was removed.
 */
import { DbAdapter } from "./db-adapter.js";

const cache = new Map<string, { ids: string[]; ts: number }>();
const CACHE_TTL = 60_000; // 1 minute
const MAX_CACHE_SIZE = 1000;

export async function getVisibleAuthors(db: DbAdapter, userId: string): Promise<string[]> {
  const now = Date.now();
  const cached = cache.get(userId);
  if (cached && now - cached.ts < CACHE_TTL) return cached.ids;

  const ids = await db.getVisibleAuthorIds(userId);
  if (!ids.includes(userId)) ids.push(userId);

  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(userId, { ids, ts: now });
  return ids;
}
