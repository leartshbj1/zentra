/** Reassemble words by their position, rather than OCR paragraph order: payslip
 * tables and right-aligned employee addresses often form separate OCR blocks. */
export function payrollOcrRows(tsv: string, fallback: string): string {
  const words = tsv.split(/\r?\n/).slice(1).flatMap(line => {
    const cells = line.split('\t');
    const [level, , , , , , left, top, width, height, confidence] = cells.map(Number);
    const text = cells.slice(11).join('\t').trim();
    return level === 5 && text && confidence >= 0 && [left, top, width, height].every(Number.isFinite) ? [{ left, center: top + height / 2, height, text }] : [];
  }).sort((a, b) => a.center - b.center || a.left - b.left);
  if (!words.length) return fallback;
  const rows: Array<{ center: number; height: number; words: typeof words }> = [];
  for (const word of words) {
    const previous = rows.at(-1);
    if (previous && Math.abs(previous.center - word.center) <= Math.max(3, Math.min(previous.height, word.height) * .55)) {
      previous.words.push(word);
    } else rows.push({ center: word.center, height: word.height, words: [word] });
  }
  return rows.map(row => row.words.sort((a,b) => a.left - b.left).map(word => word.text).join(' ')).join('\n');
}
