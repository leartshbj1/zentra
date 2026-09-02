export type PayrollPdfTextItem = {
  str?: unknown;
  hasEOL?: unknown;
  transform?: unknown;
  width?: unknown;
  height?: unknown;
};

export type PayrollPdfPageGeometry = {
  width: number;
  height: number;
};

const MAX_PAGE_TEXT_CHARS = 8_000;

/**
 * Reconstruit une couche texte lisible sans faire confiance au contenu du PDF.
 * Les sauts de ligne signalés par PDF.js sont conservés pour éviter de coller
 * un libellé à un montant provenant de la ligne suivante.
 */
export function normalizePayrollPdfTextItems(
  items: readonly unknown[],
  page?: PayrollPdfPageGeometry,
): string {
  const hasExplicitLineBreaks = items.some((rawItem) => (
    Boolean(rawItem)
    && typeof rawItem === 'object'
    && (rawItem as PayrollPdfTextItem).hasEOL === true
  ));
  const fragments: string[] = [];
  let previousY: number | null = null;
  let previousHeight = 0;
  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as PayrollPdfTextItem;
    if (typeof item.str !== 'string') continue;
    const transform = Array.isArray(item.transform)
      && item.transform.length >= 6
      && item.transform.slice(0, 6).every((value) => typeof value === 'number' && Number.isFinite(value))
      ? item.transform as number[]
      : null;
    const x = transform?.[4];
    const y = transform?.[5];
    const height = typeof item.height === 'number' && Number.isFinite(item.height)
      ? Math.abs(item.height)
      : transform
        ? Math.hypot(transform[2], transform[3])
        : 0;
    if (
      page
      && x !== undefined
      && y !== undefined
      && (x < -1 || x > page.width + 1 || y < -1 || y > page.height + 1)
    ) continue;
    const text = item.str.replace(/\u0000/g, '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').trim();
    if (text) {
      const changedVisualLine = y !== undefined
        && previousY !== null
        && Math.abs(y - previousY) > Math.max(2, Math.min(12, Math.max(height, previousHeight) * 0.55));
      // Certains PDF ne fournissent aucun `hasEOL`. Sans coordonnées fiables,
      // réunir toute la page sur une seule ligne permettrait à un libellé et à
      // un montant sans rapport de se corroborer. Dans ce cas, chaque objet
      // texte reste volontairement isolé.
      const uncertainLayoutBreak = !hasExplicitLineBreaks && !transform && fragments.length > 0;
      if ((changedVisualLine || uncertainLayoutBreak) && fragments.at(-1) !== '\n')
        fragments.push('\n');
      fragments.push(text);
      if (y !== undefined) previousY = y;
      previousHeight = height;
    }
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
