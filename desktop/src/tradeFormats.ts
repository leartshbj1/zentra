/**
 * Formats d'échange du bâtiment, lus sur l'appareil (aucun envoi) :
 *  - Datanorm 4 et 5 (grossistes) : enregistrements séparés par « ; »,
 *    A (article), B (complément : EAN…), P (prix), T (texte long), V (en-tête) ;
 *  - BMEcat 1.2 et 2005 (XML) : ARTICLE / PRODUCT ;
 *  - NPK / CAN et soumissions SIA 451 en texte : la norme SIA 451 et le
 *    format IfA18 (.crbx) sont vendus par SIA/CRB et leur mise en page n'est
 *    pas publique ; on reconnaît la structure NPK publique (chapitre à trois
 *    chiffres, position « 211.111 », texte, unité, quantité, prix) dans un
 *    fichier à champs séparés ou en colonnes.
 * Zentra ne fournit aucun catalogue : chaque client importe le sien.
 */

export type TradeArticle = {
  sku: string;
  name: string;
  description: string;
  unit: string;
  /** Prix de vente (prix public / liste), en centimes par unité. */
  salesPriceCents: number;
  /** Prix d'achat (net), en centimes par unité ; 0 si inconnu. */
  purchaseCostCents: number;
  ean: string;
  vatBp: number | null;
};
export type TradeCatalog = { format: 'datanorm' | 'bmecat' | 'npk'; articles: TradeArticle[]; warnings: string[] };

const UNIT_MAP: Record<string, string> = {
  stck: 'pièce', stk: 'pièce', st: 'pièce', stuck: 'pièce', pce: 'pièce', pc: 'pièce', pcs: 'pièce', c62: 'pièce', h87: 'pièce', ea: 'pièce', pi: 'pièce', piece: 'pièce', pièce: 'pièce',
  m: 'm', mtr: 'm', lm: 'm', m1: 'm', ml: 'm',
  m2: 'm²', qm: 'm²', mtk: 'm²', 'm²': 'm²',
  m3: 'm³', cbm: 'm³', mtq: 'm³', 'm³': 'm³',
  kg: 'kg', kgm: 'kg', g: 'g', grm: 'g', t: 't', tne: 't',
  l: 'l', ltr: 'l', lt: 'l',
  h: 'h', std: 'h', hur: 'h', heure: 'h',
  pak: 'paquet', pk: 'paquet', pa: 'paquet', set: 'set', rol: 'rouleau', ro: 'rouleau', rll: 'rouleau', sa: 'sac', sack: 'sac', bg: 'sac', kar: 'carton', ct: 'carton',
  gl: 'forfait', psch: 'forfait', pau: 'forfait', fft: 'forfait', lsu: 'forfait',
};

/** Unité d'un fichier professionnel → unité de Zentra (inconnue : en minuscules). */
export function tradeUnit(value: string): string {
  const key = value.trim().toLowerCase().replace(/\./g, '');
  return UNIT_MAP[key] ?? (key.slice(0, 32) || 'pièce');
}

const clean = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

/** « 1590 » en centimes ; Datanorm écrit les prix sans virgule (2 décimales implicites). */
function datanormCents(value: string): number | null {
  const digits = value.trim().replace(/^0+(?=\d)/, '');
  if (!/^\d{1,13}$/.test(digits)) return null;
  return Number(digits);
}

/** Preiseinheit Datanorm : 0/1/2/3 (par 1/10/100/1000) ou directement 1/10/100/1000. */
function priceUnitDivisor(value: string): number {
  const code = value.trim();
  if (code === '' || code === '0' || code === '1') return 1;
  if (code === '2' || code === '100') return 100;
  if (code === '3' || code === '1000') return 1000;
  if (code === '10') return 10;
  return 1;
}

/** Datanorm 4/5 : texte du fichier (déjà décodé). */
export function parseDatanorm(text: string): TradeCatalog {
  const warnings: string[] = [];
  const articles = new Map<string, TradeArticle & { textKey: string }>();
  const longTexts = new Map<string, string[]>();
  let version = '';
  let skipped = 0;
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\u001a/g, '');
    if (!line.trim()) continue;
    const fields = line.split(';');
    const type = fields[0].trim().toUpperCase();
    if (type === 'V') {
      version = fields.find(field => /^0?(4|5)\d{0,2}$/.test(field.trim()))?.trim() ?? version;
      continue;
    }
    const action = (fields[1] ?? '').trim().toUpperCase();
    if (action === 'L') { articles.delete(clean(fields[2])); continue; }
    if (type === 'A') {
      // A;VKZ;Artikelnummer;Textkennzeichen;Kurztext1;Kurztext2;Preiskennzeichen;Preiseinheit;Mengeneinheit;Preis;Rabattgruppe;Warengruppe;Langtextschlüssel
      const sku = clean(fields[2]);
      const name = clean([fields[4], fields[5]].filter(Boolean).join(' '));
      const cents = datanormCents(fields[9] ?? '');
      if (!sku || !name || cents === null) { skipped += 1; continue; }
      const perUnit = Math.round(cents / priceUnitDivisor(fields[7] ?? ''));
      const kind = (fields[6] ?? '').trim();
      const previous = articles.get(sku);
      articles.set(sku, {
        sku: sku.slice(0, 80), name: name.slice(0, 200), description: previous?.description ?? '', unit: tradeUnit(fields[8] ?? ''),
        salesPriceCents: kind === '2' ? previous?.salesPriceCents ?? perUnit : perUnit,
        purchaseCostCents: kind === '2' ? perUnit : previous?.purchaseCostCents ?? 0,
        ean: previous?.ean ?? '', vatBp: null, textKey: clean(fields[12]),
      });
    } else if (type === 'B') {
      // B;VKZ;Artikelnummer;Matchcode;Alternativnummer;Katalogseite;;;EAN;…
      const article = articles.get(clean(fields[2]));
      const ean = clean(fields[8]);
      if (article && /^\d{8,14}$/.test(ean)) article.ean = ean;
    } else if (type === 'P') {
      // P;VKZ;Artikelnummer;Preiskennzeichen;Preis;… (jusqu'à trois articles par ligne)
      for (let start = 2; start + 2 < fields.length; start += 7) {
        const article = articles.get(clean(fields[start]));
        const cents = datanormCents(fields[start + 2] ?? '');
        if (!article || cents === null) continue;
        if ((fields[start + 1] ?? '').trim() === '2') article.purchaseCostCents = cents;
        else article.salesPriceCents = cents;
      }
    } else if (type === 'T') {
      // T;VKZ;Textnummer;…;Text — on garde les morceaux de texte lisibles.
      const key = clean(fields[2]);
      const content = clean(fields.slice(3).filter(part => /[A-Za-zÀ-ÿ]{2}/.test(part)).join(' '));
      if (key && content) longTexts.set(key, [...(longTexts.get(key) ?? []), content]);
    }
  }
  for (const article of articles.values()) {
    const long = article.textKey ? longTexts.get(article.textKey) : undefined;
    if (long) article.description = long.join(' ').slice(0, 2_000);
  }
  if (!articles.size) throw new Error('Aucun article Datanorm lisible : le fichier doit contenir des enregistrements A séparés par « ; ».');
  if (version && !/^0?[45]/.test(version)) warnings.push(`Version Datanorm ${version} : seuls les enregistrements A, B, P et T sont lus.`);
  if (skipped) warnings.push(`${skipped} article(s) sans numéro, désignation ou prix ont été ignorés.`);
  return { format: 'datanorm', articles: [...articles.values()].map(({ textKey: _textKey, ...article }) => article), warnings };
}

/** Montant décimal « 15.90 » / « 15,9 » → centimes. */
function decimalCents(value: string | null | undefined): number | null {
  const cleaned = (value ?? '').trim().replace(',', '.');
  if (!/^\d{1,11}(\.\d{1,6})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

export type XmlNode = { localName: string; textContent: string | null; children: ArrayLike<XmlNode>; getAttribute(name: string): string | null };
const childrenOf = (node: XmlNode) => Array.from(node.children);
const child = (node: XmlNode, ...names: string[]) => childrenOf(node).find(item => names.includes(item.localName.toUpperCase()));
const childText = (node: XmlNode | undefined, ...names: string[]) => clean(node ? child(node, ...names)?.textContent ?? '' : '');
function descendants(node: XmlNode, names: string[], found: XmlNode[] = []): XmlNode[] {
  for (const item of childrenOf(node)) {
    if (names.includes(item.localName.toUpperCase())) found.push(item);
    else descendants(item, names, found);
  }
  return found;
}

/** BMEcat 1.2 / 2005 ; `parse` reçoit le XML et rend la racine (DOMParser à l'écran). */
export function parseBmecat(xml: string, parse: (xml: string) => XmlNode | null): TradeCatalog {
  const root = parse(xml);
  if (!root || root.localName.toUpperCase() !== 'BMECAT') throw new Error('Ce fichier XML n’est pas un catalogue BMEcat.');
  const warnings: string[] = [];
  const header = child(root, 'HEADER');
  const catalog = header ? child(header, 'CATALOG') : undefined;
  const currency = childText(catalog, 'CURRENCY') || 'CHF';
  const items = descendants(root, ['ARTICLE', 'PRODUCT']);
  const articles: TradeArticle[] = [];
  let foreign = 0, skipped = 0;
  for (const item of items) {
    const details = child(item, 'ARTICLE_DETAILS', 'PRODUCT_DETAILS');
    const order = child(item, 'ARTICLE_ORDER_DETAILS', 'PRODUCT_ORDER_DETAILS');
    const sku = childText(item, 'SUPPLIER_AID', 'SUPPLIER_PID');
    const name = childText(details, 'DESCRIPTION_SHORT');
    const ids = details ? childrenOf(details).filter(node => node.localName.toUpperCase() === 'INTERNATIONAL_PID' && /gtin|ean/i.test(node.getAttribute('type') ?? 'gtin')) : [];
    const ean = childText(details, 'EAN') || clean(ids[0]?.textContent ?? '');
    const priceQuantity = Number(childText(order, 'PRICE_QUANTITY').replace(',', '.')) || 1;
    let list: number | null = null, net: number | null = null, vat: number | null = null, itemCurrency = currency;
    for (const block of descendants(item, ['ARTICLE_PRICE_DETAILS', 'PRODUCT_PRICE_DETAILS'])) {
      for (const price of childrenOf(block).filter(node => /^(ARTICLE|PRODUCT)_PRICE$/.test(node.localName.toUpperCase()))) {
        const type = (price.getAttribute('price_type') ?? '').toLowerCase();
        const amount = decimalCents(childText(price, 'PRICE_AMOUNT'));
        if (amount === null) continue;
        itemCurrency = childText(price, 'PRICE_CURRENCY') || itemCurrency;
        const tax = Number(childText(price, 'TAX').replace(',', '.'));
        if (Number.isFinite(tax) && tax > 0 && tax < 1) vat = Math.round(tax * 10_000);
        if (/^net/.test(type)) net ??= amount; else list ??= amount;
      }
    }
    if (itemCurrency.toUpperCase() !== 'CHF') { foreign += 1; continue; }
    if (!sku || !name || (list === null && net === null)) { skipped += 1; continue; }
    const perUnit = (cents: number | null) => (cents === null ? 0 : Math.round(cents / priceQuantity));
    articles.push({
      sku: sku.slice(0, 80), name: name.slice(0, 200), description: childText(details, 'DESCRIPTION_LONG').slice(0, 2_000),
      unit: tradeUnit(childText(order, 'ORDER_UNIT')), salesPriceCents: perUnit(list ?? net), purchaseCostCents: perUnit(net), ean: /^\d{8,14}$/.test(ean) ? ean : '', vatBp: vat,
    });
  }
  if (foreign) warnings.push(`${foreign} article(s) dans une autre devise que le CHF n’ont pas été repris.`);
  if (skipped) warnings.push(`${skipped} article(s) sans référence, désignation ou prix ont été ignorés.`);
  if (!articles.length) throw new Error('Aucun article BMEcat lisible en CHF dans ce fichier.');
  return { format: 'bmecat', articles, warnings };
}

export type NpkPosition = { number: string; chapter: string; text: string; unit: string; quantity: number | null; unitPriceCents: number | null };
export type NpkDocument = { chapters: Map<string, string>; positions: NpkPosition[]; warnings: string[] };

const POSITION = /^\s*(\d{3})[ .]?(\d{3})(?:[ .](\d{1,3}))?(?=\s|;|\t|$)/;
const CHAPTER = /^\s*(\d{3})(?:\s+|;|\t)(?!\d{3}\b)(.+)$/;
const number = (value: string | undefined) => {
  const cleaned = (value ?? '').trim().replace(/['’\s]/g, '').replace(',', '.');
  return /^\d+(\.\d+)?$/.test(cleaned) ? Number(cleaned) : null;
};

/**
 * Positions NPK / CAN d'un fichier texte : champs séparés (« ; » ou tabulation)
 * avec en-tête facultatif, ou colonnes libres « 211.111  Texte  m3  125  48.50 ».
 */
export function parseNpkText(text: string): NpkDocument {
  const chapters = new Map<string, string>();
  const positions: NpkPosition[] = [];
  const warnings: string[] = [];
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  const separator = lines.slice(0, 30).some(line => line.includes('\t')) ? '\t' : lines.slice(0, 30).filter(line => line.includes(';')).length >= 2 ? ';' : null;
  let header: Record<'text' | 'unit' | 'quantity' | 'price', number> | null = null;
  for (const line of lines) {
    const cells = separator ? line.split(separator).map(cell => cell.trim()) : null;
    if (cells && !header && !POSITION.test(line)) {
      const lower = cells.map(cell => cell.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase());
      const find = (words: string[]) => lower.findIndex(cell => words.some(word => cell.startsWith(word)));
      const found = { text: find(['texte', 'designation', 'libelle', 'text', 'bezeichnung', 'descrizione']), unit: find(['unite', 'einheit', 'unit', 'unita', 'me']), quantity: find(['quantite', 'menge', 'quantity', 'quantita', 'qte']), price: find(['prix', 'preis', 'ep', 'price', 'prezzo']) };
      if (found.text >= 0 && found.unit >= 0) { header = found; continue; }
    }
    const position = POSITION.exec(line);
    if (!position) {
      const chapter = CHAPTER.exec(cells ? cells.filter(Boolean).join(' ') : line);
      if (chapter && chapter[2].replace(/[^A-Za-zÀ-ÿ]/g, '').length >= 3) chapters.set(chapter[1], clean(chapter[2]).slice(0, 120));
      continue;
    }
    const numberText = `${position[1]}.${position[2]}${position[3] ? '.' + position[3] : ''}`;
    let body: string, unit = '', quantity: number | null = null, price: number | null = null;
    if (cells && header) {
      body = cells[header.text] ?? '';
      unit = cells[header.unit] ?? '';
      quantity = header.quantity >= 0 ? number(cells[header.quantity]) : null;
      price = header.price >= 0 ? number(cells[header.price]) : null;
    } else if (cells) {
      const rest = cells.slice(1).filter(Boolean);
      body = rest.find(cell => number(cell) === null && cell.length > 3) ?? '';
      const after = rest.slice(rest.indexOf(body) + 1);
      unit = after.find(cell => number(cell) === null) ?? '';
      const numbers = after.map(number).filter((value): value is number => value !== null);
      [quantity, price] = [numbers[0] ?? null, numbers[1] ?? null];
    } else {
      const tail = /^(.*?)\s{2,}([A-Za-zµ][A-Za-z0-9µ²³.]{0,7})\s+([\d'’.,]+)(?:\s+([\d'’.,]+))?\s*$/.exec(line.slice(position[0].length));
      if (tail) { body = tail[1]; unit = tail[2]; quantity = number(tail[3]); price = tail[4] === undefined ? null : number(tail[4]); }
      else body = line.slice(position[0].length);
    }
    body = clean(body);
    if (!body) continue;
    // Les positions « .000 » / « .100 » sans quantité sont des titres de sous-chapitre.
    if (position[2].endsWith('00') && !unit && quantity === null) { chapters.set(`${position[1]}.${position[2]}`, body.slice(0, 120)); continue; }
    positions.push({ number: numberText, chapter: position[1], text: body.slice(0, 500), unit: unit ? tradeUnit(unit) : 'forfait', quantity, unitPriceCents: price === null ? null : Math.round(price * 100) });
  }
  if (!positions.length) throw new Error('Aucune position NPK reconnue (numéro « 211.111 » suivi d’un texte).');
  if (/<\?xml|PK\u0003\u0004/.test(text.slice(0, 200))) warnings.push('Les fichiers IfA18 (.crbx) ne sont pas encore lus : exportez la soumission en SIA 451 texte ou en CSV.');
  return { chapters, positions, warnings };
}

/** Catalogue NPK / CAN du client → prestations du catalogue (numéro de position comme référence). */
export function npkCatalog(document: NpkDocument): TradeCatalog {
  return {
    format: 'npk',
    articles: document.positions.map(position => ({ sku: position.number, name: position.text.slice(0, 200), description: '', unit: position.unit, salesPriceCents: position.unitPriceCents ?? 0, purchaseCostCents: 0, ean: '', vatBp: null })),
    warnings: document.warnings,
  };
}

/** Soumission (SIA 451 / NPK en texte) → lignes de devis avec chapitres. */
export function submissionLines(document: NpkDocument): { sectionTitle: string | null; description: string; quantity: number; unit: string; unitPriceCents: number }[] {
  return document.positions.map(position => ({
    sectionTitle: document.chapters.get(position.chapter) ? `${position.chapter} ${document.chapters.get(position.chapter)}` : position.chapter,
    description: `${position.number} ${position.text}`,
    quantity: position.quantity ?? 0,
    unit: position.unit,
    unitPriceCents: position.unitPriceCents ?? 0,
  }));
}

const amount = (cents: number) => (cents / 100).toFixed(2);
const csvCell = (value: string) => (/[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/**
 * Offre chiffrée pour un bureau d'architecte : positions dans l'ordre du devis,
 * numéro NPK repris en tête de désignation, prix unitaire et montant. Texte à
 * champs séparés « ; » (structure NPK) ; ce n'est pas un fichier SIA 451 certifié.
 */
export function offerExport(lines: readonly { sectionTitle?: string | null; description: string; quantity: number; unit: string; unitPriceCents: number; discountBp?: number }[], title: string): string {
  const rows = [['Position', 'Texte', 'Unité', 'Quantité', 'Prix unitaire', 'Rabais %', 'Montant'].join(';')];
  let chapter: string | null | undefined;
  for (const line of lines) {
    if ((line.sectionTitle ?? null) !== chapter) {
      chapter = line.sectionTitle ?? null;
      if (chapter) rows.push([csvCell(/^\d{3}\b/.exec(chapter)?.[0] ?? ''), csvCell(chapter.replace(/^\d{3}\s*/, '')), '', '', '', '', ''].join(';'));
    }
    const match = POSITION.exec(line.description);
    const position = match ? match[0].trim() : '';
    const text = match ? line.description.slice(match[0].length).trim() : line.description;
    const base = Math.round(line.quantity * line.unitPriceCents);
    const net = base - Math.round((base * (line.discountBp ?? 0)) / 10_000);
    rows.push([csvCell(position), csvCell(text), csvCell(line.unit), String(line.quantity), amount(line.unitPriceCents), String((line.discountBp ?? 0) / 100), amount(net)].join(';'));
  }
  return `﻿${csvCell(title)}\r\n${rows.join('\r\n')}\r\n`;
}

/** Reconnaît le format d'après le nom et le début du fichier. */
export function detectTradeFormat(fileName: string, head: string): 'datanorm' | 'bmecat' | 'npk' | null {
  const name = fileName.toLowerCase();
  if (/<bmecat[\s>]/i.test(head)) return 'bmecat';
  const first = head.split(/\r?\n/).find(line => line.trim()) ?? '';
  if (/^[VAB];/.test(first) || /^V\s*;?\s*0?[45]/.test(first) || /\.(dat|00\d|wrg|rab)$/.test(name) && /^[AVBPT];/m.test(head)) return 'datanorm';
  if (/\.(01s|sia|npk|can|s451)$/.test(name) || /^\s*\d{3}[ .]\d{3}\b/m.test(head)) return 'npk';
  return null;
}
