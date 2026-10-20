// Lecture du contenu d'une QR-facture suisse (« SPC », version 2.x des
// Swiss Implementation Guidelines QR-bill). Tout est contrôlé de façon
// déterministe : IBAN, référence QR, référence créancier, montant.

export type QrBillAddress = Readonly<{
  /** « S » structurée ; « K » combinée (ancienne forme, encore lue). */
  type: 'S' | 'K';
  name: string;
  street: string;
  buildingNumber: string;
  postalCode: string;
  city: string;
  /** Pour une adresse combinée : ligne 1 et ligne 2 telles quelles. */
  addressLine1: string;
  addressLine2: string;
  country: string;
}>;

export type QrBillReferenceType = 'QRR' | 'SCOR' | 'NON';

/** Informations de facture « //S1/ » (recommandation Swico). */
export type QrBillInformation = Readonly<{
  invoiceNumber: string | null;
  /** AAAA-MM-JJ */
  invoiceDate: string | null;
  customerReference: string | null;
  vatNumber: string | null;
  /** Conditions : escompte en pour cent et délai en jours. 0 % = net. */
  conditions: ReadonlyArray<Readonly<{ discountPercent: number; days: number }>>;
  /**
   * TVA (balise 32) : un seul taux pour tout le montant (netAmountCents null),
   * ou une liste « taux:montant net ».
   */
  vat: ReadonlyArray<Readonly<{ ratePercent: number; netAmountCents: number | null }>>;
}>;

export type QrBill = Readonly<{
  version: string;
  iban: string;
  isQrIban: boolean;
  creditor: QrBillAddress;
  /** null quand la facture laisse le montant libre. */
  amountCents: number | null;
  currency: 'CHF' | 'EUR';
  debtor: QrBillAddress | null;
  referenceType: QrBillReferenceType;
  reference: string;
  message: string;
  billInformation: QrBillInformation | null;
  rawBillInformation: string;
  alternativeProcedures: readonly string[];
}>;

export type QrBillProblem =
  | 'not_swiss_qr'
  | 'unsupported_version'
  | 'line_count'
  | 'invalid_iban'
  | 'invalid_creditor'
  | 'invalid_amount'
  | 'invalid_currency'
  | 'invalid_reference'
  | 'reference_iban_mismatch'
  | 'missing_trailer';

export type QrBillParseResult =
  | Readonly<{ ok: true; bill: QrBill }>
  | Readonly<{ ok: false; problem: QrBillProblem }>;

export function normalizeIbanText(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function mod97(value: string): number {
  let remainder = 0;
  for (const character of value) {
    const digits = /\d/.test(character) ? character : String(character.charCodeAt(0) - 55);
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  CH: 21, LI: 21, AT: 20, BE: 16, DE: 22, DK: 18, ES: 24, FI: 18, FR: 27, GB: 22, IE: 22,
  IT: 27, LU: 20, MC: 27, NL: 18, NO: 15, PL: 28, PT: 25, SE: 24, SM: 27, CZ: 24, HU: 28,
  HR: 21, SI: 19, SK: 24, GR: 27, EE: 20, LT: 20, LV: 21, CY: 28, MT: 31, IS: 26, BG: 22, RO: 24,
};

/** IBAN valide (longueur du pays et clé 97). */
export function isValidIban(value: string): boolean {
  const iban = normalizeIbanText(value);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(iban)) return false;
  const expected = IBAN_LENGTHS[iban.slice(0, 2)];
  if (expected !== undefined && iban.length !== expected) return false;
  return mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1;
}

export function isSwissIban(value: string): boolean {
  const iban = normalizeIbanText(value);
  return /^(CH|LI)\d{7}[A-Z0-9]{12}$/.test(iban) && isValidIban(iban);
}

/** QR-IBAN : IID entre 30000 et 31999. */
export function isQrIban(value: string): boolean {
  const iban = normalizeIbanText(value);
  if (!isSwissIban(iban)) return false;
  const iid = Number(iban.slice(4, 9));
  return iid >= 30000 && iid <= 31999;
}

const MOD10_TABLE = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];

/** Chiffre de contrôle modulo 10 récursif (référence QR, BVR). */
export function mod10RecursiveCheckDigit(digits: string): number {
  let carry = 0;
  for (const digit of digits) carry = MOD10_TABLE[(carry + Number(digit)) % 10];
  return (10 - carry) % 10;
}

export function isValidQrReference(value: string): boolean {
  const reference = value.replace(/\s+/g, '');
  if (!/^\d{27}$/.test(reference)) return false;
  return mod10RecursiveCheckDigit(reference.slice(0, 26)) === Number(reference[26]);
}

/** Référence créancier ISO 11649 (RF…). */
export function isValidCreditorReference(value: string): boolean {
  const reference = value.replace(/\s+/g, '').toUpperCase();
  if (!/^RF\d{2}[A-Z0-9]{1,21}$/.test(reference)) return false;
  return mod97(`${reference.slice(4)}${reference.slice(0, 4)}`) === 1;
}

/** « 1949.75 » → 194975 ; vide → null ; invalide → undefined. */
export function parseQrAmount(value: string): number | null | undefined {
  const text = value.trim();
  if (text === '') return null;
  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return undefined;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (cents < 1 || cents > 99_999_999_999) return undefined;
  return cents;
}

function readAddress(fields: readonly string[], offset: number): QrBillAddress | null | undefined {
  const [type, name, first, second, postalCode, city, country] = fields.slice(offset, offset + 7).map((value) => value.trim());
  if (!type && !name && !first && !second && !postalCode && !city && !country) return null;
  if ((type !== 'S' && type !== 'K') || !name || !/^[A-Z]{2}$/.test(country)) return undefined;
  if (type === 'S') {
    if (!city) return undefined;
    return { type, name, street: first, buildingNumber: second, postalCode, city, addressLine1: '', addressLine2: '', country };
  }
  if (!second || postalCode || city) return undefined;
  // Adresse combinée : « 2501 Biel » sur la ligne 2.
  const town = /^(\d{4,5})\s+(.+)$/.exec(second);
  return {
    type,
    name,
    street: '',
    buildingNumber: '',
    postalCode: town?.[1] ?? '',
    city: town?.[2] ?? second,
    addressLine1: first,
    addressLine2: second,
    country,
  };
}

function parseShortDate(value: string): string | null {
  const match = /^(\d{2})(\d{2})(\d{2})$/.exec(value);
  if (!match) return null;
  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${match[2]}-${match[3]}`;
}

/** Lit « //S1/10/…/11/…/40/… ». Les barres obliques échappées « \/ » sont gardées. */
export function parseBillInformation(value: string): QrBillInformation | null {
  const text = value.trim();
  if (!text.startsWith('//S1/')) return null;
  const parts: string[] = [];
  let current = '';
  for (let i = 5; i < text.length; i += 1) {
    const character = text[i];
    if (character === '\\' && text[i + 1] === '/') {
      current += '/';
      i += 1;
    } else if (character === '/') {
      parts.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  parts.push(current);
  const tags = new Map<string, string>();
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (/^\d{2}$/.test(parts[i]) && !tags.has(parts[i])) tags.set(parts[i], parts[i + 1]);
  }
  const dates = tags.get('11') ?? '';
  const conditions = (tags.get('40') ?? '')
    .split(';')
    .map((entry) => /^(\d+(?:\.\d+)?):(\d+)$/.exec(entry.trim()))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ discountPercent: Number(match[1]), days: Number(match[2]) }));
  const vatText = (tags.get('32') ?? '').trim();
  const vat = /^\d+(?:\.\d+)?$/.test(vatText)
    ? [{ ratePercent: Number(vatText), netAmountCents: null }]
    : vatText.split(';').map((entry) => /^(\d+(?:\.\d+)?):(\d{1,9}(?:\.\d{1,2})?)$/.exec(entry.trim()))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => ({ ratePercent: Number(match[1]), netAmountCents: parseQrAmount(match[2]) ?? null }));
  return {
    invoiceNumber: tags.get('10') || null,
    invoiceDate: parseShortDate(dates.slice(0, 6)),
    customerReference: tags.get('20') || null,
    vatNumber: tags.get('30') ? `CHE-${tags.get('30')!.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1.$2.$3')}` : null,
    conditions,
    vat,
  };
}

export function parseSwissQrBill(payload: string): QrBillParseResult {
  const text = payload.replace(/^﻿/, '');
  const fields = text.split(/\r\n|\n|\r/);
  if (fields[0]?.trim() !== 'SPC') return { ok: false, problem: 'not_swiss_qr' };
  const version = fields[1]?.trim() ?? '';
  if (!/^02\d{2}$/.test(version) || fields[2]?.trim() !== '1') return { ok: false, problem: 'unsupported_version' };
  // Les retours à la ligne finaux ne comptent pas.
  while (fields.length > 31 && fields[fields.length - 1] === '') fields.pop();
  if (fields.length < 31 || fields.length > 34) return { ok: false, problem: 'line_count' };
  if (fields[30].trim() !== 'EPD') return { ok: false, problem: 'missing_trailer' };

  const iban = normalizeIbanText(fields[3]);
  if (!isSwissIban(iban)) return { ok: false, problem: 'invalid_iban' };
  const creditor = readAddress(fields, 4);
  if (!creditor) return { ok: false, problem: 'invalid_creditor' };
  const amountCents = parseQrAmount(fields[18]);
  if (amountCents === undefined) return { ok: false, problem: 'invalid_amount' };
  const currency = fields[19].trim();
  if (currency !== 'CHF' && currency !== 'EUR') return { ok: false, problem: 'invalid_currency' };
  const debtor = readAddress(fields, 20);
  if (debtor === undefined) return { ok: false, problem: 'invalid_creditor' };
  const referenceType = fields[27].trim();
  const reference = fields[28].replace(/\s+/g, '');
  if (referenceType !== 'QRR' && referenceType !== 'SCOR' && referenceType !== 'NON') {
    return { ok: false, problem: 'invalid_reference' };
  }
  if (referenceType === 'QRR' && !isValidQrReference(reference)) return { ok: false, problem: 'invalid_reference' };
  if (referenceType === 'SCOR' && !isValidCreditorReference(reference)) return { ok: false, problem: 'invalid_reference' };
  if (referenceType === 'NON' && reference !== '') return { ok: false, problem: 'invalid_reference' };
  const qrIban = isQrIban(iban);
  if (qrIban !== (referenceType === 'QRR')) return { ok: false, problem: 'reference_iban_mismatch' };

  const rawBillInformation = (fields[31] ?? '').trim();
  return {
    ok: true,
    bill: {
      version,
      iban,
      isQrIban: qrIban,
      creditor,
      amountCents,
      currency,
      debtor,
      referenceType,
      reference: referenceType === 'SCOR' ? reference.toUpperCase() : reference,
      message: fields[29].trim(),
      billInformation: parseBillInformation(rawBillInformation),
      rawBillInformation,
      alternativeProcedures: fields.slice(32).map((value) => value.trim()).filter(Boolean),
    },
  };
}

/** Échéance déduite des conditions : la plus longue, à partir de la date de facture. */
export function qrBillDueDate(bill: QrBill): string | null {
  const information = bill.billInformation;
  if (!information?.invoiceDate || information.conditions.length === 0) return null;
  const days = Math.max(...information.conditions.map((condition) => condition.days));
  const date = new Date(`${information.invoiceDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Groupe une référence pour l'affichage : QRR par 5 depuis la droite, RF par 4. */
export function formatPaymentReference(type: QrBillReferenceType, reference: string): string {
  if (type === 'QRR') {
    const head = reference.slice(0, reference.length % 5 || 0);
    const groups = reference.slice(head.length).match(/.{5}/g) ?? [];
    return [head, ...groups].filter(Boolean).join(' ');
  }
  if (type === 'SCOR') return reference.match(/.{1,4}/g)?.join(' ') ?? reference;
  return reference;
}

export function formatIban(iban: string): string {
  return normalizeIbanText(iban).match(/.{1,4}/g)?.join(' ') ?? iban;
}
