/** Index one freshly read snapshot. No cross-company or stale-data cache. */
export function groupRows<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

/** Preserve Array.find semantics when a legacy input contains duplicates. */
export function firstRows<T, K>(rows: readonly T[], key: (row: T) => K): Map<K, T> {
  const index = new Map<K, T>();
  for (const row of rows) { const id = key(row); if (!index.has(id)) index.set(id, row); }
  return index;
}
