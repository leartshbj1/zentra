type DatedDocument = { issueDate: string; createdAt: string; number: string; id: string };

/** Document date first; creation time resolves documents issued on the same day. */
export function newestDocumentsFirst<T extends DatedDocument>(documents: readonly T[]): T[] {
  return [...documents].sort((left, right) =>
    (right.issueDate || right.createdAt.slice(0, 10)).localeCompare(left.issueDate || left.createdAt.slice(0, 10))
    || right.createdAt.localeCompare(left.createdAt)
    || right.number.localeCompare(left.number, 'fr-CH', { numeric: true })
    || right.id.localeCompare(left.id),
  );
}
