// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { buildPaymentOrder, formatAmount, paymentMessageId, paymentText, type PaymentOrderInput } from './pain001';

// Extrait du schéma pain.001.001.09 (ISO 20022) restreint par les Swiss
// Payment Standards : ordre des éléments, cardinalités, longueurs et motifs
// des types simples. Couvre tous les éléments que l'app produit.
type Child = readonly [name: string, min: number, max: number];
const SEQUENCES: Readonly<Record<string, readonly Child[]>> = {
  Document: [['CstmrCdtTrfInitn', 1, 1]],
  CstmrCdtTrfInitn: [['GrpHdr', 1, 1], ['PmtInf', 1, Infinity]],
  GrpHdr: [['MsgId', 1, 1], ['CreDtTm', 1, 1], ['NbOfTxs', 1, 1], ['CtrlSum', 0, 1], ['InitgPty', 1, 1]],
  InitgPty: [['Nm', 0, 1]],
  PmtInf: [
    ['PmtInfId', 1, 1], ['PmtMtd', 1, 1], ['BtchBookg', 0, 1], ['NbOfTxs', 0, 1], ['CtrlSum', 0, 1], ['PmtTpInf', 0, 1],
    ['ReqdExctnDt', 1, 1], ['Dbtr', 1, 1], ['DbtrAcct', 1, 1], ['DbtrAgt', 1, 1], ['ChrgBr', 0, 1], ['CdtTrfTxInf', 1, Infinity],
  ],
  PmtTpInf: [['SvcLvl', 0, 1]],
  SvcLvl: [['Cd', 1, 1]],
  ReqdExctnDt: [['Dt', 1, 1]],
  Dbtr: [['Nm', 1, 1], ['PstlAdr', 0, 1]],
  Cdtr: [['Nm', 1, 1], ['PstlAdr', 0, 1]],
  PstlAdr: [['StrtNm', 0, 1], ['BldgNb', 0, 1], ['PstCd', 0, 1], ['TwnNm', 1, 1], ['Ctry', 1, 1], ['AdrLine', 0, 2]],
  DbtrAcct: [['Id', 1, 1]],
  CdtrAcct: [['Id', 1, 1]],
  Id: [['IBAN', 1, 1]],
  DbtrAgt: [['FinInstnId', 1, 1]],
  CdtrAgt: [['FinInstnId', 1, 1]],
  FinInstnId: [['BICFI', 0, 1], ['ClrSysMmbId', 0, 1]],
  ClrSysMmbId: [['ClrSysId', 1, 1], ['MmbId', 1, 1]],
  ClrSysId: [['Cd', 1, 1]],
  CdtTrfTxInf: [['PmtId', 1, 1], ['Amt', 1, 1], ['CdtrAgt', 0, 1], ['Cdtr', 1, 1], ['CdtrAcct', 1, 1], ['RmtInf', 0, 1]],
  PmtId: [['InstrId', 0, 1], ['EndToEndId', 1, 1]],
  Amt: [['InstdAmt', 1, 1]],
  RmtInf: [['Ustrd', 0, 1], ['Strd', 0, 1]],
  Strd: [['CdtrRefInf', 0, 1], ['AddtlRmtInf', 0, 3]],
  CdtrRefInf: [['Tp', 0, 1], ['Ref', 1, 1]],
  Tp: [['CdOrPrtry', 1, 1]],
  CdOrPrtry: [['Cd', 0, 1], ['Prtry', 0, 1]],
};
const TEXT = /^[^<>]*$/;
const SIMPLE: Readonly<Record<string, RegExp>> = {
  MsgId: /^[A-Za-z0-9+?/\-:().,' ]{1,35}$/,
  PmtInfId: /^[A-Za-z0-9+?/\-:().,' ]{1,35}$/,
  EndToEndId: /^[A-Za-z0-9+?/\-:().,' ]{1,35}$/,
  CreDtTm: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/,
  Dt: /^\d{4}-\d{2}-\d{2}$/,
  NbOfTxs: /^[0-9]{1,15}$/,
  CtrlSum: /^\d{1,16}\.\d{2}$/,
  InstdAmt: /^\d{1,9}\.\d{2}$/,
  PmtMtd: /^TRF$/,
  BtchBookg: /^(true|false)$/,
  ChrgBr: /^(DEBT|CRED|SHAR|SLEV)$/,
  IBAN: /^[A-Z]{2}[0-9]{2}[a-zA-Z0-9]{1,30}$/,
  BICFI: /^[A-Z0-9]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/,
  MmbId: /^\d{3,5}$/,
  Ctry: /^[A-Z]{2}$/,
  Nm: /^.{1,70}$/,
  StrtNm: /^.{1,70}$/,
  BldgNb: /^.{1,16}$/,
  PstCd: /^.{1,16}$/,
  TwnNm: /^.{1,35}$/,
  AdrLine: /^.{1,70}$/,
  Ustrd: /^.{1,140}$/,
  AddtlRmtInf: /^.{1,140}$/,
  Ref: /^.{1,35}$/,
  Cd: /^[A-Z]{1,5}$/,
  Prtry: /^QRR$/,
};

/** Rend la liste des écarts au schéma ; vide si le document est conforme. */
function schemaErrors(xml: string): string[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const errors: string[] = [];
  if (document.getElementsByTagName('parsererror').length) return ['xml mal formé'];
  const root = document.documentElement;
  if (root.namespaceURI !== 'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09') errors.push('espace de noms');
  const visit = (node: Element, path: string) => {
    const name = node.localName;
    const sequence = SEQUENCES[name];
    const children = [...node.children];
    if (!sequence) {
      if (children.length) errors.push(`${path}: enfants inattendus`);
      const pattern = SIMPLE[name];
      const text = node.textContent ?? '';
      if (!pattern) errors.push(`${path}: élément inconnu`);
      else if (!pattern.test(text) || !TEXT.test(text)) errors.push(`${path}: valeur « ${text} »`);
      if (name === 'InstdAmt' && !/^(CHF|EUR)$/.test(node.getAttribute('Ccy') ?? '')) errors.push(`${path}: monnaie`);
      return;
    }
    let index = 0;
    for (const [childName, min, max] of sequence) {
      let count = 0;
      while (index < children.length && children[index].localName === childName) {
        visit(children[index], `${path}/${childName}`);
        index += 1;
        count += 1;
      }
      if (count < min || count > max) errors.push(`${path}/${childName}: ${count} au lieu de ${min}..${max}`);
    }
    if (index < children.length) errors.push(`${path}: ${children[index].localName} hors séquence`);
    if (name === 'FinInstnId' && children.length !== 1) errors.push(`${path}: choix BIC ou IID`);
    if (name === 'CdOrPrtry' && children.length !== 1) errors.push(`${path}: choix Cd ou Prtry`);
    if (name === 'RmtInf' && children.length !== 1) errors.push(`${path}: Ustrd ou Strd, pas les deux`);
  };
  visit(root, 'Document');
  // Totaux de contrôle cohérents à chaque niveau.
  const sum = (nodes: Element[]) => nodes.reduce((total, node) => total + Math.round(Number(node.textContent) * 100), 0);
  const amounts = [...document.getElementsByTagName('InstdAmt')];
  const header = document.getElementsByTagName('GrpHdr')[0];
  if (Number(header.getElementsByTagName('NbOfTxs')[0].textContent) !== amounts.length) errors.push('NbOfTxs global');
  if (Math.round(Number(header.getElementsByTagName('CtrlSum')[0].textContent) * 100) !== sum(amounts)) errors.push('CtrlSum global');
  for (const block of [...document.getElementsByTagName('PmtInf')]) {
    const own = [...block.getElementsByTagName('InstdAmt')];
    const count = [...block.children].find((child) => child.localName === 'NbOfTxs');
    const control = [...block.children].find((child) => child.localName === 'CtrlSum');
    if (Number(count?.textContent) !== own.length) errors.push('NbOfTxs du bloc');
    if (Math.round(Number(control?.textContent) * 100) !== sum(own)) errors.push('CtrlSum du bloc');
  }
  return errors;
}

const DEBTOR = {
  name: 'Menuiserie Dupont Sàrl',
  iban: 'CH93 0076 2011 6238 5295 7',
  address: { street: 'Route de Berne', buildingNumber: '12', postalCode: '1700', city: 'Fribourg', country: 'CH' },
};

function input(lines: PaymentOrderInput['lines']): PaymentOrderInput {
  return { messageId: 'ZENTRA-20261020-101500-A1B2', createdAt: '2026-10-20T10:15:00', executionDate: '2026-10-21', debtor: DEBTOR, lines };
}

const QR_LINE = {
  endToEndId: 'R-2026-118',
  amountCents: 194975,
  currency: 'CHF',
  creditor: {
    name: 'Robert Schneider AG',
    iban: 'CH4431999123000889012',
    address: { street: 'Rue du Lac', buildingNumber: '1268', postalCode: '2501', city: 'Biel', country: 'CH' },
  },
  reference: { type: 'QRR', value: '210000000003139471430009017' },
  message: 'Facture 10201409',
} as const;

describe('ordre de paiement pain.001.001.09', () => {
  it('produit un fichier conforme pour trois factures suisses', () => {
    const result = buildPaymentOrder(input([
      QR_LINE,
      {
        endToEndId: 'R-2026-119',
        amountCents: 8990,
        currency: 'CHF',
        creditor: { name: 'Swisscom (Schweiz) AG', iban: 'CH5800791123000889012', address: { city: 'Worblaufen', country: 'CH' } },
        reference: { type: 'SCOR', value: 'RF18 5390 0754 7034' },
      },
      {
        endToEndId: 'R-2026-120',
        amountCents: 2500,
        currency: 'CHF',
        creditor: { name: 'Imprimerie Œuvre & Fils', iban: 'CH93 0076 2011 6238 5295 7', address: { addressLine: 'Grand-Rue 4', postalCode: '1630', city: 'Bulle', country: 'CH' } },
        reference: { type: 'NON' },
        message: 'Facture n° 2026/77 – merci',
      },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transactionCount).toBe(3);
    expect(result.controlSumCents).toBe(206465);
    expect(result.groups).toBe(1);
    expect(schemaErrors(result.xml)).toEqual([]);
    expect(result.xml).toContain('<CtrlSum>2064.65</CtrlSum>');
    expect(result.xml).toContain('<Prtry>QRR</Prtry>');
    expect(result.xml).toContain('<Ref>210000000003139471430009017</Ref>');
    expect(result.xml).toContain('<Cd>SCOR</Cd>');
    expect(result.xml).toContain('<Ref>RF18539007547034</Ref>');
    expect(result.xml).toContain('<Nm>Imprimerie OEuvre &amp; Fils</Nm>');
    expect(result.xml).toContain('<Ustrd>Facture no 2026/77 - merci</Ustrd>');
    // Sans BIC, la banque du débiteur est donnée par son IID.
    expect(result.xml).toContain('<MmbId>00762</MmbId>');
  });

  it('sépare les virements SEPA en euros dans leur propre bloc', () => {
    const result = buildPaymentOrder(input([
      QR_LINE,
      {
        endToEndId: 'R-2026-121',
        amountCents: 12000,
        currency: 'EUR',
        creditor: { name: 'Holzhandel GmbH', iban: 'DE89 3704 0044 0532 0130 00', bic: 'COBADEFFXXX', address: { street: 'Hauptstraße', buildingNumber: '5', postalCode: '79539', city: 'Lörrach', country: 'DE' } },
        reference: { type: 'NON' },
        message: 'Rechnung 4471',
      },
    ]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.groups).toBe(2);
    expect(schemaErrors(result.xml)).toEqual([]);
    expect(result.xml).toContain('<Cd>SEPA</Cd>');
    expect(result.xml).toContain('<ChrgBr>SLEV</ChrgBr>');
    expect(result.xml).toContain('<BICFI>COBADEFFXXX</BICFI>');
  });

  it('refuse les combinaisons interdites par la norme, avec la ligne concernée', () => {
    const result = buildPaymentOrder(input([
      { ...QR_LINE, reference: { type: 'NON' } },
      { ...QR_LINE, endToEndId: 'R-2', creditor: { ...QR_LINE.creditor, iban: 'CH93 0076 2011 6238 5295 7' } },
      { ...QR_LINE, endToEndId: 'R-3', currency: 'CHF', creditor: { ...QR_LINE.creditor, iban: 'DE89370400440532013000' } },
      { ...QR_LINE, endToEndId: 'R-4', amountCents: 0 },
      { ...QR_LINE, endToEndId: 'R-4' },
    ]));
    expect(result).toEqual({
      ok: false,
      issues: [
        { index: 0, problem: 'qr_iban_requires_qr_reference' },
        { index: 1, problem: 'qr_reference_requires_qr_iban' },
        { index: 2, problem: 'foreign_payment_not_supported' },
        { index: 3, problem: 'invalid_amount' },
        { index: 4, problem: 'duplicate_end_to_end_id' },
      ],
    });
  });

  it('refuse un compte de débit invalide et un ordre vide', () => {
    const result = buildPaymentOrder({ ...input([]), debtor: { ...DEBTOR, iban: 'CH93 0076 2011 6238 5295 8' } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.issues.map((issue) => issue.problem)).toEqual(['no_lines', 'invalid_debtor_iban']);
  });

  it('écrit les montants au centime, sans erreur d’arrondi', () => {
    expect(formatAmount(1)).toBe('0.01');
    expect(formatAmount(10)).toBe('0.10');
    expect(formatAmount(194975)).toBe('1949.75');
    expect(formatAmount(99_999_999_999)).toBe('999999999.99');
  });

  it('garde les lettres accentuées admises et remplace le reste', () => {
    expect(paymentText('Müller & Söhne – Zürich', 70)).toBe('Müller & Söhne - Zürich');
    expect(paymentText('Łódź ✓ test', 70)).toBe('Lódz test');
    expect(paymentText('a'.repeat(80), 70)).toHaveLength(70);
    expect(paymentMessageId('2026-10-20T10:15:00', 'A1B2')).toBe('ZENTRA-20261020-101500-A1B2');
  });
});
