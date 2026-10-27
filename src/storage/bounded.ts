import type { StateFirstDB } from '@feltdb/core';

/** The largest page one FeltDB bounded query returns. */
export const FELTDB_QUERY_PAGE_LIMIT = 1000;

/**
 * At most `max` records of `collection` whose fields equal `where`, read with
 * bounded queries at the storage boundary (pages of up to 1000, following the
 * cursor). Equality on a field with a hash index is answered from the index.
 * The result is re-checked against `where`, so a runtime that over-returns
 * cannot widen it.
 */
export async function boundedFind<T extends object>(db: StateFirstDB, collection: string, where: Readonly<Record<string, unknown>>, max: number): Promise<T[]> {
  const conditions = Object.entries(where).map(([field, eq]) => ({ field, eq }));
  const matches = (record: T) => Object.entries(where).every(([field, value]) => (record as Record<string, unknown>)[field] === value);
  const found: T[] = [];
  let cursor: string | undefined;
  while (found.length < max) {
    const page = await db.query<T>({ collection, where: conditions, limit: Math.min(FELTDB_QUERY_PAGE_LIMIT, max - found.length), ...(cursor ? { cursor } : {}) });
    found.push(...page.records.filter(matches));
    if (page.exhausted || !page.nextCursor || page.records.length === 0) break;
    cursor = page.nextCursor;
  }
  return found.slice(0, max);
}
