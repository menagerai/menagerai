export function ttlCache<K, V>(ttlMs: number, maxEntries = 1000) {
  const entries = new Map<K, { value: V; at: number }>();

  function prune(now = Date.now()): void {
    for (const [key, entry] of entries) {
      if (now - entry.at >= ttlMs) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  }

  return {
    get(key: K): V | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      const now = Date.now();
      if (now - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: K, value: V): void {
      entries.set(key, { value, at: Date.now() });
      if (entries.size > maxEntries) prune();
    },
    delete(key: K): void {
      entries.delete(key);
    },
    deleteWhere(predicate: (key: K) => boolean): void {
      for (const key of entries.keys()) {
        if (predicate(key)) entries.delete(key);
      }
    },
    clear(): void {
      entries.clear();
    },
  };
}
