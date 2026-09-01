export type PayrollPdfTextItem = {
  str?: unknown;
  hasEOL?: unknown;
};

const MAX_PAGE_TEXT_CHARS = 8_000;

/**
 * Reconstruit une couche texte lisible sans faire confiance au contenu du PDF.
 * Les sauts de ligne signalés par PDF.js sont conservés pour éviter de coller
 * un libellé à un montant provenant de la ligne suivante.
 */
export function normalizePayrollPdfTextItems(items: readonly unknown[]): string {
  const fragments: string[] = [];
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as PayrollPdfTextItem;
    if (typeof item.str !== 'string') continue;
    const text = item.str.replace(/\u0000/g, '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim();
    if (text) fragments.push(text);
    if (item.hasEOL === true && fragments.at(-1) !== '\n') fragments.push('\n');
  }

  return fragments
    .join(' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, MAX_PAGE_TEXT_CHARS);
}

/**
 * Ne fournit à un lot visuel que la couche texte de ses propres pages. Cela
 * empêche une valeur de la page 8 d'être attribuée par erreur au lot 1–3 et
 * rend les numéros de page demandés au modèle vérifiables.
 */
export function payrollTextForPageBatch(
  pageTexts: readonly string[],
  pageStart: number,
  pageEnd: number,
  maxChars = 24_000,
): string {
  if (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart) return '';
  const blocks: string[] = [];
  for (let page = pageStart; page <= pageEnd; page += 1) {
    const text = pageTexts[page - 1]?.trim();
    if (text) blocks.push(`[PAGE ${page}]\n${text}`);
  }
  return blocks.join('\n\n').slice(0, Math.max(0, maxChars));
}
