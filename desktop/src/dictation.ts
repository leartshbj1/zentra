import type { CatalogItem, Client, DocumentLine } from './types';

/**
 * Dictée → brouillon. Le texte vient de la reconnaissance vocale de l'appareil
 * (ou du clavier) ; cette lecture est déterministe : elle repère le client
 * nommé, les heures et les quantités, puis cherche chaque élément dans le
 * catalogue. Les prix viennent du catalogue, jamais du texte ; un élément
 * introuvable devient une ligne à compléter, à zéro franc.
 */
export type DictationDraft = {
  clientId: string | null;
  /** Nom entendu mais introuvable dans les clients. */
  partyName: string | null;
  description: string;
  lines: DocumentLine[];
  missing: string[];
};

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, neuf: 9, dix: 10, onze: 11, douze: 12, quinze: 15, vingt: 20, trente: 30, cinquante: 50, cent: 100,
  ein: 1, eine: 1, einen: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, zwanzig: 20,
  uno: 1, due: 2, tre: 3, quattro: 4, cinque: 5, sette: 7, otto: 8, nove: 9, dieci: 10, venti: 20,
  one: 1, two: 2, three: 3, four: 4, five: 5, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20,
};
// « et demie » devient un seul mot avant le découpage, pour ne pas être lu comme un nouvel élément.
const HALF_SAID = /\s+(?:et\s+demie?|und\s+eine?\s+halbe|e\s+mezz[ao]|and\s+a\s+half)\b/gi;
const HALF = /^\s*\+demi\b/i;
/** Le texte tel qu'il a été dit, pour les libellés. */
const spoken = (value: string) => value.replace(/\s*\+demi\b/g, ' et demie');
const HOURS = '(?:h\\b|heures?|stunden?|std\\.?|ore|ora|hours?|hrs?)';
const NUMBER = `(\\d+(?:[.,]\\d+)?|${Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length).join('|')})`;
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'en', 'et', 'a', 'à', 'au', 'aux', 'd', 'l', 'pour', 'avec', 'von', 'der', 'die', 'das', 'mit', 'und', 'di', 'del', 'della', 'il', 'lo', 'con', 'of', 'the', 'with', 'and', 'mm', 'pce', 'pièce', 'pièces', 'piece', 'pieces']);

const plain = (value: string) => value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('fr-CH');
const singular = (word: string) => (word.length > 3 && /[sx]$/.test(word) ? word.slice(0, -1) : word);
const tokens = (value: string) => plain(value).split(/[^a-z0-9]+/).filter(word => word && !STOP.has(word)).map(singular);

function numberValue(raw: string): number | null {
  const value = NUMBER_WORDS[raw.toLocaleLowerCase('fr-CH')] ?? Number(raw.replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** Durée dite en heures : « deux heures », « 2h30 », « 1,5 h », « une heure et demie », « une demi-heure ». */
export function readHours(said: string): number | null {
  const segment = said.replace(HALF_SAID, ' +demi');
  if (/\bdemi-?heure\b|\bhalbe\s+stunde\b|\bmezz'?ora\b|\bhalf\s+an\s+hour\b/i.test(segment)) return 0.5;
  const compact = /\b(\d{1,2})\s*h\s*(\d{2})\b/i.exec(segment);
  if (compact) return Number(compact[1]) + Number(compact[2]) / 60;
  const match = new RegExp(`(?:^|\\s)${NUMBER}\\s*${HOURS}`, 'i').exec(segment);
  if (!match) return null;
  const value = numberValue(match[1]);
  if (value === null) return null;
  return HALF.test(segment.slice((match.index ?? 0) + match[0].length)) ? value + 0.5 : value;
}

/** Quantité en tête d'un élément : « trois coudes de 22 » → 3 et « coudes de 22 ». */
export function readQuantity(segment: string): { quantity: number; words: string } | null {
  const match = new RegExp(`^(?:avec|plus|et|mit|und|con|e|with|and|pose(?:r)?\\s+de|posé|fourni)?\\s*${NUMBER}\\s+(.+)$`, 'i').exec(segment.trim());
  if (!match) return null;
  const quantity = numberValue(match[1]);
  const words = match[2].trim();
  return quantity && tokens(words).length ? { quantity, words } : null;
}

/** L'article du catalogue dont le nom est le mieux couvert par les mots dits, s'il est seul en tête. */
export function matchCatalog(words: string, catalogue: readonly CatalogItem[]): CatalogItem | null {
  const said = new Set(tokens(words));
  if (!said.size) return null;
  const scored = catalogue.filter(item => !item.archivedAt).map(item => {
    const name = tokens(item.name);
    const common = name.filter(word => said.has(word)).length;
    return { item, score: name.length ? common / name.length : 0, common };
  }).filter(row => row.common > 0 && row.score >= 0.5).sort((a, b) => b.score - a.score || b.common - a.common);
  if (!scored.length || (scored[1] && scored[1].score === scored[0].score && scored[1].common === scored[0].common)) return null;
  return scored[0].item;
}

const HOUR_UNITS = ['h', 'heure', 'heures', 'hour', 'hours', 'std', 'stunde', 'stunden', 'ora', 'ore'];

/** Le client nommé : « chez Keller », « pour Mme Rochat », ou un nom de client présent tel quel dans la dictée. */
export function findDictatedClient(text: string, clients: readonly Client[]): { client: Client | null; name: string | null } {
  const active = clients.filter(client => !client.archivedAt);
  const said = plain(text);
  const named = active.filter(client => [client.company, client.name].some(value => {
    const words = plain(value ?? '').split(/[^a-z0-9]+/).filter(word => word.length >= 4 && !['famille', 'madame', 'monsieur', 'sarl', 'gmbh'].includes(word));
    return words.some(word => new RegExp(`\\b${word}\\b`).test(said));
  }));
  if (named.length === 1) return { client: named[0], name: named[0].company || named[0].name };
  const intro = /(?:^|\s)(?:[Cc]hez|[Pp]our|[Bb]ei|[Ff]ür|[Pp]er|[Pp]resso|[Ff]or)\s+(?:(?:[Mm]\.|[Mm]me|[Mm]adame|[Mm]onsieur|[Hh]err|[Ff]rau|[Ff]amille|[Ff]amilie|[Ss]ig\.|[Ss]ignora)\s+)?([A-ZÀ-Ü][\p{L}'’-]+(?:\s+[A-ZÀ-Ü][\p{L}'’-]+)?)/u.exec(text);
  return { client: null, name: intro?.[1] ?? null };
}

/** Lit la dictée et prépare les lignes ; rien n'est enregistré ici. */
export function dictationDraft(text: string, clients: readonly Client[], catalogue: readonly CatalogItem[], vatRegistered: boolean, newId: () => string): DictationDraft {
  const clean = text.replace(/\s+/g, ' ').trim().replace(HALF_SAID, ' +demi');
  const { client, name } = findDictatedClient(clean, clients);
  const active = catalogue.filter(item => !item.archivedAt);
  const hourly = active.filter(item => HOUR_UNITS.includes(plain(item.unit)));
  const segments = clean.split(/\s*(?:[.;,\n]|\s(?:et|puis|plus|und|dann|e|poi|and|then)\s)\s*/i).map(part => part.trim()).filter(Boolean);
  const lines: DocumentLine[] = [], missing: string[] = [], description: string[] = [];
  const line = (item: CatalogItem | null, label: string, quantity: number, unit: string): DocumentLine => item
    ? { id: newId(), catalogItemId: item.id, description: item.name, quantity, unit: item.unit, unitPriceCents: item.salesPriceCents, discountBp: 0, vatRateBp: item.vatBp }
    : { id: newId(), catalogItemId: null, description: label, quantity, unit, unitPriceCents: 0, discountBp: 0, vatRateBp: vatRegistered ? -1 : 0 };
  for (const segment of segments) {
    const hours = readHours(segment);
    if (hours !== null) {
      // « deux heures de pose de carrelage » : l'article horaire nommé, sinon le seul article horaire du catalogue.
      const named = matchCatalog(segment.replace(new RegExp(`${NUMBER}\\s*${HOURS}`, 'i'), ''), hourly);
      const item = named ?? (hourly.length === 1 ? hourly[0] : null);
      if (!item) missing.push(spoken(segment));
      lines.push(line(item, spoken(segment), Math.round(hours * 100) / 100, 'h'));
      continue;
    }
    const counted = readQuantity(segment);
    if (counted) {
      const item = matchCatalog(counted.words, active);
      if (!item) missing.push(segment.replace(/^(?:avec|plus|et|mit|und|con|e|with|and)\s+/i, ''));
      lines.push(line(item, counted.words.charAt(0).toLocaleUpperCase('fr-CH') + counted.words.slice(1), counted.quantity, item?.unit ?? 'pce'));
      continue;
    }
    // « Chez Keller » seul ne décrit pas le travail : le client est déjà choisi.
    if (/^(?:chez|pour|bei|für|per|presso|for)\s/i.test(segment) && segment.split(/\s+/).length <= 4) continue;
    description.push(spoken(segment));
  }
  const sentence = description.join(', ');
  return {
    clientId: client?.id ?? null, partyName: client ? null : name,
    description: sentence ? sentence.charAt(0).toLocaleUpperCase('fr-CH') + sentence.slice(1) + (/[.!?]$/.test(sentence) ? '' : '.') : '',
    lines, missing,
  };
}
