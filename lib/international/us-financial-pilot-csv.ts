/** Exact USD decimals. Callers validate canonical minor strings first. */
export function financialPilotCsvDecimal(minor: string): string {
  const value = BigInt(minor), absolute = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? '-' : ''}${absolute / BigInt(100)}.${(absolute % BigInt(100)).toString().padStart(2, '0')}`;
}
/** Unicode whitespace/format prefixes must not hide a spreadsheet formula.
 * Only validated monetary cells bypass this text guard, retaining exact negatives. */
export function financialPilotCsvTextCell(value: string): string { return /^[\p{White_Space}\p{Cf}]*[=+\-@]/u.test(value) ? `'${value}` : value; }
export const financialPilotCsvQuoted = (value: string) => `"${value.replace(/"/g, '""')}"`;
