// A small in-memory cache for scrape results.
// - Results are reused for `ttlMs`, so re-opening the same URL doesn't launch the browser again.
// - Identical requests that arrive while a scrape is running share that one scrape.
// - At most `maxEntries` results are kept (least recently used are evicted first).
// - Failed scrapes are never cached.

export interface CachedValue<T> {
  value: T;
  /** True when the value came from an earlier, completed request. */
  cached: boolean;
  /** When the value was produced (ms since epoch). */
  producedAt: number;
}

interface Entry<T> {
  promise: Promise<T>;
  producedAt: number | null; // null while still running
}

export function createCache<T>({
  ttlMs,
  maxEntries,
  now = Date.now,
}: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}) {
  const entries = new Map<string, Entry<T>>();

  const evict = () => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) {
      if (entry.producedAt !== null && entry.producedAt < cutoff) entries.delete(key);
    }
    // Map iteration order is insertion order: the first keys are the least recently used.
    for (const key of entries.keys()) {
      if (entries.size <= maxEntries) break;
      if (entries.get(key)!.producedAt !== null) entries.delete(key);
    }
  };

  return {
    /** Returns the cached value for `key`, or runs `produce` (unless `fresh`, which always runs it). */
    async get(key: string, produce: () => Promise<T>, { fresh = false } = {}): Promise<CachedValue<T>> {
      if (ttlMs <= 0) return { value: await produce(), cached: false, producedAt: now() };

      const existing = entries.get(key);
      if (existing && !fresh) {
        if (existing.producedAt === null) {
          // Join the scrape that is already running.
          const value = await existing.promise;
          return { value, cached: false, producedAt: existing.producedAt ?? now() };
        }
        if (now() - existing.producedAt < ttlMs) {
          entries.delete(key); // move to the most-recently-used end
          entries.set(key, existing);
          return { value: await existing.promise, cached: true, producedAt: existing.producedAt };
        }
      }

      const entry: Entry<T> = { promise: produce(), producedAt: null };
      entries.set(key, entry);
      try {
        const value = await entry.promise;
        entry.producedAt = now();
        evict();
        return { value, cached: false, producedAt: entry.producedAt };
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
    },
    get size() {
      return entries.size;
    },
  };
}
