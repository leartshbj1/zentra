// Ordre de paiement ISO 20022 pain.001.001.09, selon les Swiss Payment
// Standards (SPS, Customer Credit Transfer Initiation). Le fichier est
// déposé dans l'e-banking : la banque exécute, l'app ne paie rien elle-même.
//
// Couvert : paiements suisses (IBAN ou QR-IBAN CH/LI, CHF ou EUR) avec
// référence QR, référence créancier ou communication libre, et virements
// SEPA en euros. Les autres paiements à l'étranger sont refusés avec la
// raison, ils restent à saisir dans l'e-banking.

import {
  isQrIban,
  isSwissIban,
  isValidCreditorReference,
  isValidIban,
  isValidQrReference,
  normalizeIbanText,
} from './swissQrBill';

export type PaymentAddress = Readonly<{
  street?: string;
  buildingNumber?: string;
  postalCode?: string;
  city?: string;
  /** Pour une adresse saisie en texte libre (« Rue du Lac 12 »). */
  addressLine?: string;
  country?: string;
}>;

export type PaymentParty = Readonly<{
  name: string;
  iban: string;
  bic?: string;
  address?: PaymentAddress;
}>;

export type PaymentReference =
  | Readonly<{ type: 'QRR'; value: string }>
  | Readonly<{ type: 'SCOR'; value: string }>
  | Readonly<{ type: 'NON'; value?: '' }>;

export type PaymentOrderLine = Readonly<{
  /** Identifiant de bout en bout, repris tel quel sur le relevé (35 car. max). */
  endToEndId: string;
  amountCents: number;
  currency: 'CHF' | 'EUR';
  creditor: PaymentParty;
  reference: PaymentReference;
  /** Communication au créancier (140 car. max). */
  message?: string;
}>;

export type PaymentOrderInput = Readonly<{
  messageId: string;
  /** AAAA-MM-JJTHH:MM:SS, heure locale. */
  createdAt: string;
  /** AAAA-MM-JJ */
  executionDate: string;
  debtor: PaymentParty;
  lines: readonly PaymentOrderLine[];
}>;

export type PaymentOrderProblem =
  | 'no_lines'
  | 'invalid_message_id'
  | 'invalid_date'
  | 'invalid_debtor_iban'
  | 'invalid_debtor_name'
  | 'invalid_amount'
  | 'invalid_creditor_iban'
  | 'invalid_creditor_name'
  | 'invalid_reference'
  | 'qr_iban_requires_qr_reference'
  | 'qr_reference_requires_qr_iban'
  | 'foreign_payment_not_supported'
  | 'duplicate_end_to_end_id';

export type PaymentOrderIssue = Readonly<{ index: number | null; problem: PaymentOrderProblem }>;

export type PaymentOrderResult =
  | Readonly<{ ok: true; xml: string; transactionCount: number; controlSumCents: number; groups: number }>
  | Readonly<{ ok: false; issues: readonly PaymentOrderIssue[] }>;

const NAMESPACE = 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09';

// Pays de la zone SEPA (virement SEPA en euros).
const SEPA_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GB', 'GR', 'HR', 'HU', 'IE', 'IS', 'IT',
  'LI', 'LT', 'LU', 'LV', 'MC', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK', 'SM', 'VA', 'AD',
]);

// Jeu de caractères admis par les SPS (latin de base et lettres accentuées usuelles).
const ALLOWED = /[A-Za-z0-9 .,:'+\-/()?!"#%&*;<>=@_$£[\]{}\\`´~àáâäçèéêëìíîïñòóôöùúûüýßÀÁÂÄÇÈÉÊËÌÍÎÏÒÓÔÖÙÚÛÜÑ]/;
const IDENTIFIER = /^[A-Za-z0-9+?/\-:().,' ]{1,35}$/;
const TRANSLITERATION: Readonly<Record<string, string>> = {
  'œ': 'oe', 'Œ': 'OE', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'å': 'a', 'Å': 'A', 'ł': 'l', 'Ł': 'L',
  '’': "'", '‘': "'", '“': '"', '”': '"', '«': '"', '»': '"', '–': '-', '—': '-', '°': 'o',' ': ' ',
};

/** Ramène un texte au jeu de caractères SPS, sans perdre le sens. */
export function paymentText(value: string, maxLength: number): string {
  let result = '';
  for (const character of value.normalize('NFC')) {
    if (ALLOWED.test(character)) {
      result += character;
      continue;
    }
    if (TRANSLITERATION[character] !== undefined) {
      result += TRANSLITERATION[character];
      continue;
    }
    const base = character.normalize('NFD').replace(/[̀-ͯ]/g, '');
    result += base && [...base].every((part) => ALLOWED.test(part)) ? base : ' ';
  }
  return [...result.replace(/\s+/g, ' ').trim()].slice(0, maxLength).join('').trim();
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function formatAmount(cents: number): string {
  const whole = Math.floor(cents / 100);
  return `${whole}.${String(cents % 100).padStart(2, '0')}`;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

type Kind = 'domestic' | 'sepa';

function lineKind(line: PaymentOrderLine): Kind | null {
  const iban = normalizeIbanText(line.creditor.iban);
  if (isSwissIban(iban)) return 'domestic';
  if (line.currency === 'EUR' && SEPA_COUNTRIES.has(iban.slice(0, 2)) && isValidIban(iban)) return 'sepa';
  return null;
}

export function validatePaymentOrder(input: PaymentOrderInput): PaymentOrderIssue[] {
  const issues: PaymentOrderIssue[] = [];
  if (input.lines.length === 0) issues.push({ index: null, problem: 'no_lines' });
  if (!IDENTIFIER.test(input.messageId)) issues.push({ index: null, problem: 'invalid_message_id' });
  if (!isIsoDate(input.executionDate) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input.createdAt)) {
    issues.push({ index: null, problem: 'invalid_date' });
  }
  if (!isSwissIban(input.debtor.iban)) issues.push({ index: null, problem: 'invalid_debtor_iban' });
  if (!paymentText(input.debtor.name, 70)) issues.push({ index: null, problem: 'invalid_debtor_name' });
  const seen = new Set<string>();
  input.lines.forEach((line, index) => {
    const add = (problem: PaymentOrderProblem) => issues.push({ index, problem });
    if (!Number.isSafeInteger(line.amountCents) || line.amountCents < 1 || line.amountCents > 99_999_999_999) add('invalid_amount');
    if (!paymentText(line.creditor.name, 70)) add('invalid_creditor_name');
    if (!IDENTIFIER.test(line.endToEndId)) add('invalid_message_id');
    if (seen.has(line.endToEndId)) add('duplicate_end_to_end_id');
    seen.add(line.endToEndId);
    const iban = normalizeIbanText(line.creditor.iban);
    if (!isValidIban(iban)) {
      add('invalid_creditor_iban');
      return;
    }
    const kind = lineKind(line);
    if (!kind) {
      add('foreign_payment_not_supported');
      return;
    }
    const reference = line.reference;
    if (reference.type === 'QRR' && !isValidQrReference(reference.value)) add('invalid_reference');
    if (reference.type === 'SCOR' && !isValidCreditorReference(reference.value)) add('invalid_reference');
    if (kind === 'domestic') {
      const qrIban = isQrIban(iban);
      if (qrIban && reference.type !== 'QRR') add('qr_iban_requires_qr_reference');
      if (!qrIban && reference.type === 'QRR') add('qr_reference_requires_qr_iban');
    } else if (reference.type === 'QRR') {
      add('qr_reference_requires_qr_iban');
    }
  });
  return issues;
}

function element(name: string, content: string): string {
  return `<${name}>${content}</${name}>`;
}

function textElement(name: string, value: string, maxLength: number): string {
  const text = paymentText(value, maxLength);
  return text ? element(name, escapeXml(text)) : '';
}

function postalAddress(address: PaymentAddress | undefined, fallbackCountry: string): string {
  if (!address) return '';
  const city = paymentText(address.city ?? '', 35);
  const country = /^[A-Z]{2}$/.test(address.country ?? '') ? address.country! : fallbackCountry;
  // Depuis novembre 2025, une adresse transmise doit au moins porter la localité et le pays.
  if (!city || !country) return '';
  const street = paymentText(address.street ?? '', 70);
  const parts = [
    street ? element('StrtNm', escapeXml(street)) : '',
    street ? textElement('BldgNb', address.buildingNumber ?? '', 16) : '',
    textElement('PstCd', address.postalCode ?? '', 16),
    element('TwnNm', escapeXml(city)),
    element('Ctry', country),
    !street ? textElement('AdrLine', address.addressLine ?? '', 70) : '',
  ];
  return element('PstlAdr', parts.join(''));
}

function agent(party: PaymentParty): string {
  const bic = (party.bic ?? '').replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(bic)) {
    return element('FinInstnId', element('BICFI', bic));
  }
  // Sans BIC : numéro de clearing (IID) tiré de l'IBAN suisse, admis par les SPS.
  const iid = normalizeIbanText(party.iban).slice(4, 9);
  return element('FinInstnId', element('ClrSysMmbId', element('ClrSysId', element('Cd', 'CHBCC')) + element('MmbId', iid)));
}

function remittance(line: PaymentOrderLine): string {
  const message = paymentText(line.message ?? '', 140);
  if (line.reference.type === 'NON') {
    return message ? element('RmtInf', element('Ustrd', escapeXml(message))) : '';
  }
  const type = line.reference.type === 'QRR'
    ? element('Prtry', 'QRR')
    : element('Cd', 'SCOR');
  const value = line.reference.value.replace(/\s+/g, '').toUpperCase();
  const reference = element('CdtrRefInf', element('Tp', element('CdOrPrtry', type)) + element('Ref', value));
  const additional = message ? element('AddtlRmtInf', escapeXml(message)) : '';
  return element('RmtInf', element('Strd', reference + additional));
}

function transaction(line: PaymentOrderLine, kind: Kind): string {
  const iban = normalizeIbanText(line.creditor.iban);
  const creditorCountry = iban.slice(0, 2);
  const creditorAgent = kind === 'sepa' && line.creditor.bic
    ? element('CdtrAgt', agent(line.creditor))
    : '';
  const creditor = element('Cdtr', textElement('Nm', line.creditor.name, 70) + postalAddress(line.creditor.address, creditorCountry));
  return element('CdtTrfTxInf', [
    element('PmtId', element('EndToEndId', escapeXml(line.endToEndId))),
    element('Amt', `<InstdAmt Ccy="${line.currency}">${formatAmount(line.amountCents)}</InstdAmt>`),
    creditorAgent,
    creditor,
    element('CdtrAcct', element('Id', element('IBAN', iban))),
    remittance(line),
  ].join(''));
}

/** Construit le fichier, ou rend la liste des problèmes à corriger. */
export function buildPaymentOrder(input: PaymentOrderInput): PaymentOrderResult {
  const issues = validatePaymentOrder(input);
  if (issues.length) return { ok: false, issues };

  // Un bloc PmtInf par sorte de virement et par monnaie, comme le recommandent les SPS.
  const groups = new Map<string, { kind: Kind; currency: string; lines: PaymentOrderLine[] }>();
  for (const line of input.lines) {
    const kind = lineKind(line)!;
    const key = `${kind}:${line.currency}`;
    const group = groups.get(key) ?? { kind, currency: line.currency, lines: [] };
    group.lines.push(line);
    groups.set(key, group);
  }
  const debtorIban = normalizeIbanText(input.debtor.iban);
  const debtor = element('Dbtr', textElement('Nm', input.debtor.name, 70) + postalAddress(input.debtor.address, debtorIban.slice(0, 2)));
  const total = input.lines.reduce((sum, line) => sum + line.amountCents, 0);
  let blockNumber = 0;
  const blocks = [...groups.values()].map((group) => {
    blockNumber += 1;
    const sum = group.lines.reduce((value, line) => value + line.amountCents, 0);
    const paymentType = group.kind === 'sepa'
      ? element('PmtTpInf', element('SvcLvl', element('Cd', 'SEPA')))
      : '';
    return element('PmtInf', [
      element('PmtInfId', escapeXml(`${input.messageId.slice(0, 31)}-${blockNumber}`)),
      element('PmtMtd', 'TRF'),
      element('BtchBookg', 'true'),
      element('NbOfTxs', String(group.lines.length)),
      element('CtrlSum', formatAmount(sum)),
      paymentType,
      element('ReqdExctnDt', element('Dt', input.executionDate)),
      debtor,
      element('DbtrAcct', element('Id', element('IBAN', debtorIban))),
      element('DbtrAgt', agent(input.debtor)),
      group.kind === 'sepa' ? element('ChrgBr', 'SLEV') : '',
      ...group.lines.map((line) => transaction(line, group.kind)),
    ].join(''));
  });

  const header = element('GrpHdr', [
    element('MsgId', escapeXml(input.messageId)),
    element('CreDtTm', input.createdAt),
    element('NbOfTxs', String(input.lines.length)),
    element('CtrlSum', formatAmount(total)),
    element('InitgPty', textElement('Nm', input.debtor.name, 70)),
  ].join(''));
  const body = element('CstmrCdtTrfInitn', header + blocks.join(''));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="${NAMESPACE}" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">${body}</Document>\n`;
  return { ok: true, xml: indentXml(xml), transactionCount: input.lines.length, controlSumCents: total, groups: groups.size };
}

/** Indentation lisible ; aucun nœud texte ne contient de balise, le découpage est sûr. */
function indentXml(xml: string): string {
  const [declaration, ...rest] = xml.split('\n');
  const tokens = rest.join('').match(/<[^>]+>|[^<]+/g) ?? [];
  const lines: string[] = [declaration];
  let depth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.startsWith('</')) {
      depth -= 1;
      lines.push(`${'  '.repeat(depth)}${token}`);
    } else if (token.startsWith('<')) {
      const text = tokens[i + 1];
      const closing = tokens[i + 2];
      if (text && !text.startsWith('<') && closing?.startsWith('</')) {
        lines.push(`${'  '.repeat(depth)}${token}${text}${closing}`);
        i += 2;
      } else if (token.endsWith('/>')) {
        lines.push(`${'  '.repeat(depth)}${token}`);
      } else {
        lines.push(`${'  '.repeat(depth)}${token}`);
        depth += 1;
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Identifiant de message unique et lisible : ZENTRA-AAAAMMJJ-HHMMSS-xxxx. */
export function paymentMessageId(createdAt: string, suffix: string): string {
  const compact = createdAt.replace(/[-:]/g, '').replace('T', '-');
  return paymentText(`ZENTRA-${compact}-${suffix}`, 35).replace(/ /g, '');
}
