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

/** Match a row by either foreign key without counting it twice when both match. */
export function groupRowsByKeys<T, K>(rows: readonly T[], keys: (row: T) => readonly K[]): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    for (const key of new Set(keys(row))) {
      // Unlike Map, the strict comparisons used by the original filters never match NaN.
      if (key !== key) continue;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
  }
  return groups;
}

/** Preserve the first source row across both roles of a document relationship. */
export function firstRowsByKeys<T, K>(rows: readonly T[], keys: (row: T) => readonly K[]): Map<K, T> {
  const index = new Map<K, T>();
  for (const row of rows) {
    for (const key of keys(row)) {
      if (key === key && !index.has(key)) index.set(key, row);
    }
  }
  return index;
}
