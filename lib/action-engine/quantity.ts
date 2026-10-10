import type { ActionArticle, ReviewReason } from './types';

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  eins: 1,
  ein: 1,
  eine: 1,
  einen: 1,
  einem: 1,
  eines: 1,
  zwei: 2,
  drei: 3,
  vier: 4,
  funf: 5,
  sechs: 6,
  sieben: 7,
  acht: 8,
  neun: 9,
  zehn: 10,
  elf: 11,
  zwolf: 12,
  uno: 1,
  una: 1,
  due: 2,
  tre: 3,
  quattro: 4,
  cinque: 5,
  sei: 6,
  sette: 7,
  otto: 8,
  nove: 9,
  dieci: 10,
  undici: 11,
  dodici: 12,
});
const DOCUMENT_WORDS =
  /^(?:devis|offre|quote|quotation|estimate|angebot|offerte|kostenvoranschlag|preventivo|offerta)\b/u;
const STOP_WORDS = new Set(
  'bonjour bonsoir salut hello hi dear hallo guten tag ciao buongiorno buonasera merci thank thanks you your please kindly veuillez bitte per favore cordialement regards best mit freundlichen grussen saluti cordiali je nous vous me mon ma notre nos de du des le la les the this my our would like want need request prepare provide send souhaite souhaitons voudrais voudrions besoin demande demander envoyez envoyer preparer pour for fur del della gli delle and und devis offre quote quotation estimate angebot offerte kostenvoranschlag preventivo offerta'.split(
    ' ',
  ),
);
const BOILERPLATE = new Set(
  'bonjour bonsoir salut hello hi dear hallo guten tag ciao buongiorno buonasera merci thank thanks you your please kindly veuillez bitte per favore cordialement regards best mit freundlichen grussen saluti cordiali je j nous vous me mon ma notre nos de du des le la les l a an the this my our i we would like want need request prepare provide send souhaiter souhaite souhaitons voudrais voudrions besoin demande demander envoyez envoyer preparer pour for fur di da del della il lo gli delle et and und e devis offre quote quotation estimate angebot offerte kostenvoranschlag preventivo offerta un une ein eine einen uno una'.split(
    ' ',
  ),
);

function normalized(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
function lexicalWords(value: string): string[] {
  return [
    ...new Set(
      normalized(value)
        .split(' ')
        .filter(
          (word) =>
            word.length >= 3 &&
            !STOP_WORDS.has(word) &&
            !Object.hasOwn(NUMBER_WORDS, word) &&
            !/^\d+$/u.test(word),
        ),
    ),
  ];
}
function singular(word: string): string {
  return word.length > 4 && word.endsWith('s') && !word.endsWith('ss')
    ? word.slice(0, -1)
    : word;
}

/** Split only simple sentences/lines; retain decimal punctuation and literal evidence. */
export function quotePhrases(body: string): readonly string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < body.length; index++) {
    const character = body[index];
    const boundary =
      /[\r\n;!?]/u.test(character) ||
      (character === '.' &&
        (index + 1 === body.length || /\s/u.test(body[index + 1])));
    if (boundary) {
      const phrase = body.slice(start, index).trim();
      if (phrase) result.push(phrase);
      start = index + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last) result.push(last);
  return Object.freeze(result);
}

/** Ignore metadata only when no eligible catalogue article occurs in this phrase. */
export function nonItemPhrase(phrase: string, senderName: string): boolean {
  const normalizedPhrase = normalized(phrase);
  if (senderName.trim() && normalizedPhrase === normalized(senderName))
    return true;
  if (
    /^(?:(?:offered|requested|suggested|desired|set|change|modifier)\s+)?(?:unit\s+price|price|pricing|prix(?:\s+unitaire)?|preis|prezzo|vat|tva|mwst|iva|tax|taxe|steuer|email|mail|phone|telephone|telefon|tel|adresse|address|indirizzo)\b/u.test(
      normalizedPhrase,
    )
  )
    return true;
  return normalizedPhrase
    .split(' ')
    .filter(Boolean)
    .every((word) => BOILERPLATE.has(word));
}

/** The same conservative catalogue eligibility is used when planning and committing. */
export function lexicalmatches(
  evidence: string,
  article: ActionArticle,
): boolean {
  if (article.archived) return false;
  const sourceWords = new Set(lexicalWords(evidence).map(singular));
  const sku = normalized(article.sku);
  if (
    sku &&
    /\p{L}/u.test(sku) &&
    ` ${normalized(evidence)} `.includes(` ${sku} `)
  )
    return true;
  const name = lexicalWords(article.name);
  const nameHits = name.filter((word) => sourceWords.has(singular(word)));
  if (
    nameHits.length &&
    (nameHits.length === name.length ||
      nameHits.some((word) => word.length >= 4))
  )
    return true;
  return (
    lexicalWords(article.description).filter((word) =>
      sourceWords.has(singular(word)),
    ).length >= 2
  );
}

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function withoutSkus(evidence: string, knownSkus: readonly string[]): string {
  let remaining = evidence;
  for (const sku of knownSkus) {
    // A numeric-only SKU cannot safely be distinguished from a quantity.
    if (!sku || !/\p{L}/u.test(sku)) continue;
    remaining = remaining.replace(
      new RegExp(
        `(?<![\\p{L}\\p{N}])${escapePattern(sku)}(?![\\p{L}\\p{N}])`,
        'giu',
      ),
      (match) => ' '.repeat(match.length),
    );
  }
  return remaining;
}

/** No locale is available: an apparent thousands separator requires human review. */
export function parseQuoteQuantity(
  evidence: string,
  knownSkus: readonly string[] = [],
): { quantityMilli: number | null; reason: ReviewReason | null } {
  const text = withoutSkus(evidence, knownSkus);
  const values: (number | null)[] = [];
  for (const match of text.matchAll(
    /[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:[eE][+-]?\d+)?/gu,
  )) {
    const before = text.slice(0, match.index),
      after = text.slice(match.index + match[0].length);
    if (/[\p{L}\p{N}_]$/u.test(before) || /^[\p{L}\p{N}_]/u.test(after))
      continue;
    const literal = match[0];
    if (
      !/^(?:0|[1-9]\d*)(?:[.,]\d{1,3})?$/u.test(literal) ||
      /^[1-9]\d{0,2}[.,]\d{3}$/u.test(literal)
    ) {
      values.push(null);
      continue;
    }
    const [whole, fraction = ''] = literal.replace(',', '.').split('.');
    const milli = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
    values.push(
      Number.isSafeInteger(milli) && milli >= 1 && milli <= 1_000_000
        ? milli
        : null,
    );
  }
  for (const match of text.matchAll(/\p{L}+/gu)) {
    const word = normalized(match[0]);
    if (!Object.hasOwn(NUMBER_WORDS, word)) continue;
    const after = normalized(text.slice(match.index + match[0].length));
    if (NUMBER_WORDS[word] === 1 && DOCUMENT_WORDS.test(after)) continue;
    values.push(NUMBER_WORDS[word] * 1000);
  }
  if (values.length > 1)
    return { quantityMilli: null, reason: 'ambiguous_quantity' };
  if (!values.length)
    return { quantityMilli: null, reason: 'missing_quantity' };
  return {
    quantityMilli: values[0],
    reason: values[0] === null ? 'unsupported_quantity' : null,
  };
}
