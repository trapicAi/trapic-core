/** FIFO eviction: evicts oldest-inserted key when at capacity. */
export function cacheSet<K, V>(map: Map<K, V>, key: K, value: V, maxSize: number): void {
  if (map.size >= maxSize) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
}
