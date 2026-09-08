// SQLite has signed i64 values but no i128 multiplication. Evaluate amount *
// numerator / denominator one numerator bit at a time as (quotient,remainder).
// Every remainder operation avoids overflowing 2*r or r+amount%denominator.
// With 0 <= numerator <= denominator the quotient never exceeds amount.
// This matches native rounded_proportion/proportional_vat for positive inputs.
export function roundedProportionCtes(input: string, output: string): string {
  for (const name of [input, output])
    if (!/^[a-z_][a-z0-9_]*$/.test(name))
      throw new Error('Untrusted proportion CTE name');
  const doubleR = '(CASE WHEN r>=d-r THEN r-(d-r) ELSE r+r END)';
  const bit = '((n>>bit)&1)';
  const carry = `(CASE WHEN ${doubleR}>=d-ar THEN 1 ELSE 0 END)`;
  const valid = `typeof(amount)='integer' AND typeof(numerator)='integer' AND typeof(denominator)='integer'
      AND amount>=0 AND denominator>0 AND numerator>=0 AND numerator<=denominator`;
  return `${output}_steps(id,aq,ar,d,n,bit,q,r) AS (
    SELECT id,amount/denominator,amount%denominator,denominator,numerator,62,0,0 FROM ${input}
    WHERE ${valid}
    UNION ALL
    SELECT id,aq,ar,d,n,bit-1,
      q+q+(CASE WHEN r>=d-r THEN 1 ELSE 0 END)+(CASE WHEN ${bit}=1 THEN aq+${carry} ELSE 0 END),
      CASE WHEN ${bit}=1 THEN CASE WHEN ${doubleR}>=d-ar THEN ${doubleR}-(d-ar) ELSE ${doubleR}+ar END ELSE ${doubleR} END
    FROM ${output}_steps WHERE bit>=0),
    ${output} AS MATERIALIZED (SELECT id,q+(CASE WHEN r>=d-d/2 THEN 1 ELSE 0 END) AS amount
      FROM ${output}_steps WHERE bit=-1
      UNION ALL SELECT id,NULL AS amount FROM ${input} WHERE NOT (${valid}))`;
}

// Positive aggregates across several journal entries may exceed i64 even when
// each entry is valid. Partial sums stay within i64 for the 200,000-row contract.
// Return NULL on overflow; consumers must reject it, never treat it as zero.
export function boundedPositiveSum(column: string): string {
  if (!/^[a-z_][a-z0-9_.]*$/.test(column))
    throw new Error('Untrusted monetary column');
  const high = `(SUM(${column}/1000000000)+SUM(${column}%1000000000)/1000000000)`;
  const low = `(SUM(${column}%1000000000)%1000000000)`;
  return `(CASE WHEN COUNT(${column})=COUNT(*) AND MIN(typeof(${column})='integer')=1 AND MIN(${column})>=0 AND (${high}<9223372036 OR (${high}=9223372036 AND ${low}<=854775807)) THEN ${high}*1000000000+${low} END)`;
}
