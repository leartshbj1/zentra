import { AccountPublicError } from './account-security';

export type NumberFloor = { prefix: string; year: number; minimum: number };
export const MAX_NUMBER_FLOORS = 10_000;
export function numberingFloors(value: unknown): NumberFloor[] {
  if (!Array.isArray(value) || value.length > MAX_NUMBER_FLOORS)
    throw new AccountPublicError(
      'Les bornes historiques de numérotation sont absentes ou trop nombreuses.',
    );
  let previous: NumberFloor | undefined;
  return value.map((item) => {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      Object.keys(item).sort().join(',') !== 'minimum,prefix,year' ||
      typeof item.prefix !== 'string' ||
      !/^[A-Z0-9-]{1,12}$/.test(item.prefix) ||
      !Number.isSafeInteger(item.year) ||
      item.year < 1900 ||
      item.year > 9999 ||
      !Number.isSafeInteger(item.minimum) ||
      item.minimum < 1 ||
      item.minimum > 1_000_000_000 ||
      (previous &&
        (previous.prefix > item.prefix ||
          (previous.prefix === item.prefix && previous.year >= item.year)))
    )
      throw new AccountPublicError(
        'Une borne historique de numérotation est invalide ou répétée.',
      );
    previous = { prefix: item.prefix, year: item.year, minimum: item.minimum };
    return previous;
  });
}

// Account for prefixes changed since older documents were issued, as well as
// retained local counters. Money and potentially large number strings stay SQL.
export const historicalNumberFloorsSql = `WITH RECURSIVE
  boundaries(n) AS (VALUES(2) UNION ALL SELECT n+1 FROM boundaries WHERE n<13),
  numbers AS MATERIALIZED (SELECT json_extract(row_json,'$.number') number FROM business_sync_versions
    WHERE transfer_id=?1 AND organization_id=?2 AND table_name IN
    ('quotes','invoices','sales_orders','delivery_notes','supplier_orders','supplier_receipts','supplier_credit_notes','journal_entries')
    AND json_type(row_json,'$.number')='text'),
  parts AS MATERIALIZED (SELECT substr(number,1,n-1) prefix,substr(number,n+1,4) year,substr(number,n+6) digits
    FROM numbers JOIN boundaries ON substr(number,n,1)='-' AND substr(number,n+5,1)='-'),
  derived AS (SELECT prefix,CAST(year AS INTEGER) year,
    CASE WHEN length(ltrim(digits,'0'))>9 THEN 1000000000 ELSE MIN(CAST(digits AS INTEGER)+1,1000000000) END minimum
    FROM parts WHERE prefix NOT GLOB '*[^A-Z0-9-]*' AND year NOT GLOB '*[^0-9]*'
      AND length(year)=4 AND CAST(year AS INTEGER) BETWEEN 1900 AND 9999
      AND length(digits)>0 AND digits NOT GLOB '*[^0-9]*' AND length(ltrim(digits,'0'))>0),
  supplied AS (SELECT json_extract(f.value,'$.prefix') prefix,json_extract(f.value,'$.year') year,json_extract(f.value,'$.minimum') minimum
    FROM business_sync_transfers t,json_each(t.manifest_json,'$.numbering_floors') f
    WHERE t.transfer_id=?1 AND t.organization_id=?2),
  all_floors AS (SELECT * FROM derived UNION ALL SELECT * FROM supplied)
  SELECT prefix,year,MAX(minimum) minimum FROM all_floors GROUP BY prefix,year`;
