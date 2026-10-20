import { describe, expect, it } from 'vitest';
import {
  formatPaymentReference,
  isQrIban,
  isValidCreditorReference,
  isValidIban,
  isValidQrReference,
  mod10RecursiveCheckDigit,
  parseBillInformation,
  parseQrAmount,
  parseSwissQrBill,
  qrBillDueDate,
} from './swissQrBill';

// Exemple des Swiss Implementation Guidelines (QR-IBAN + référence QR).
const QRR_EXAMPLE = [
  'SPC', '0200', '1', 'CH4431999123000889012', 'S', 'Robert Schneider AG', 'Rue du Lac', '1268', '2501', 'Biel', 'CH',
  '', '', '', '', '', '', '', '1949.75', 'CHF', 'S', 'Pia-Maria Rutschmann-Schnyder', 'Grosse Marktgasse', '28', '9400', 'Rorschach', 'CH',
  'QRR', '210000000003139471430009017', 'Ordre du 15.10.2026', 'EPD', '//S1/10/10201409/11/261015/20/1400.000-53/30/106017086/40/2:10;0:30',
].join('\r\n');

const SCOR_EXAMPLE = [
  'SPC', '0200', '1', 'CH5800791123000889012', 'S', 'Swisscom (Schweiz) AG', 'Alte Tiefenaustrasse', '6', '3048', 'Worblaufen', 'CH',
  '', '', '', '', '', '', '', '', 'CHF', '', '', '', '', '', '', '',
  'SCOR', 'RF18539007547034', '', 'EPD',
].join('\n');

describe('contrôles', () => {
  it('valide les IBAN suisses et étrangers par la clé 97', () => {
    expect(isValidIban('CH93 0076 2011 6238 5295 7')).toBe(true);
    expect(isValidIban('CH93 0076 2011 6238 5295 8')).toBe(false);
    expect(isValidIban('DE89370400440532013000')).toBe(true);
    expect(isValidIban('DE8937040044053201300')).toBe(false);
  });

  it('reconnaît le QR-IBAN par son IID', () => {
    expect(isQrIban('CH4431999123000889012')).toBe(true);
    expect(isQrIban('CH5800791123000889012')).toBe(false);
  });

  it('calcule le chiffre de contrôle modulo 10 récursif', () => {
    expect(mod10RecursiveCheckDigit('21000000000313947143000901')).toBe(7);
    expect(isValidQrReference('21 00000 00003 13947 14300 09017')).toBe(true);
    expect(isValidQrReference('210000000003139471430009018')).toBe(false);
  });

  it('valide la référence créancier ISO 11649', () => {
    expect(isValidCreditorReference('RF18 5390 0754 7034')).toBe(true);
    expect(isValidCreditorReference('RF19539007547034')).toBe(false);
  });

  it('lit les montants au centime près, sans arrondi flottant', () => {
    expect(parseQrAmount('1949.75')).toBe(194975);
    expect(parseQrAmount('0.1')).toBe(10);
    expect(parseQrAmount('12')).toBe(1200);
    expect(parseQrAmount('')).toBeNull();
    expect(parseQrAmount('12,50')).toBeUndefined();
    expect(parseQrAmount('0.00')).toBeUndefined();
  });
});

describe('lecture de la QR-facture', () => {
  it('lit tous les champs utiles de l’exemple officiel', () => {
    const result = parseSwissQrBill(QRR_EXAMPLE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { bill } = result;
    expect(bill.iban).toBe('CH4431999123000889012');
    expect(bill.isQrIban).toBe(true);
    expect(bill.creditor).toMatchObject({ name: 'Robert Schneider AG', street: 'Rue du Lac', buildingNumber: '1268', postalCode: '2501', city: 'Biel', country: 'CH' });
    expect(bill.amountCents).toBe(194975);
    expect(bill.currency).toBe('CHF');
    expect(bill.debtor?.name).toBe('Pia-Maria Rutschmann-Schnyder');
    expect(bill.referenceType).toBe('QRR');
    expect(bill.reference).toBe('210000000003139471430009017');
    expect(bill.message).toBe('Ordre du 15.10.2026');
    expect(bill.billInformation).toEqual({
      invoiceNumber: '10201409',
      invoiceDate: '2026-10-15',
      customerReference: '1400.000-53',
      vatNumber: 'CHE-106.017.086',
      conditions: [{ discountPercent: 2, days: 10 }, { discountPercent: 0, days: 30 }],
      vat: [],
    });
    expect(qrBillDueDate(bill)).toBe('2026-11-14');
  });

  it('lit une facture SCOR sans montant ni débiteur', () => {
    const result = parseSwissQrBill(SCOR_EXAMPLE);
    expect(result.ok && result.bill.amountCents).toBeNull();
    expect(result.ok && result.bill.debtor).toBeNull();
    expect(result.ok && result.bill.reference).toBe('RF18539007547034');
    expect(result.ok && qrBillDueDate(result.bill)).toBeNull();
  });

  it('lit l’ancienne adresse combinée', () => {
    const lines = QRR_EXAMPLE.split('\r\n');
    lines.splice(4, 7, 'K', 'Robert Schneider AG', 'Rue du Lac 1268', '2501 Biel', '', '', 'CH');
    const result = parseSwissQrBill(lines.join('\n'));
    expect(result.ok && result.bill.creditor).toMatchObject({ type: 'K', addressLine1: 'Rue du Lac 1268', postalCode: '2501', city: 'Biel' });
  });

  it('refuse les incohérences au lieu de les corriger', () => {
    const replace = (index: number, value: string) => {
      const lines = QRR_EXAMPLE.split('\r\n');
      lines[index] = value;
      return parseSwissQrBill(lines.join('\n'));
    };
    expect(parseSwissQrBill('https://example.ch')).toEqual({ ok: false, problem: 'not_swiss_qr' });
    expect(replace(1, '0100')).toEqual({ ok: false, problem: 'unsupported_version' });
    expect(replace(3, 'CH4431999123000889013')).toEqual({ ok: false, problem: 'invalid_iban' });
    expect(replace(18, '1949.755')).toEqual({ ok: false, problem: 'invalid_amount' });
    expect(replace(19, 'USD')).toEqual({ ok: false, problem: 'invalid_currency' });
    expect(replace(28, '210000000003139471430009018')).toEqual({ ok: false, problem: 'invalid_reference' });
    expect(replace(30, 'END')).toEqual({ ok: false, problem: 'missing_trailer' });
    // QR-IBAN sans référence QR : interdit par la norme.
    const mismatch = QRR_EXAMPLE.split('\r\n');
    mismatch[27] = 'NON';
    mismatch[28] = '';
    expect(parseSwissQrBill(mismatch.join('\n'))).toEqual({ ok: false, problem: 'reference_iban_mismatch' });
  });

  it('garde les barres obliques échappées des informations de facture', () => {
    expect(parseBillInformation('//S1/10/F\\/2026\\/12/11/261001')?.invoiceNumber).toBe('F/2026/12');
    expect(parseBillInformation('texte libre')).toBeNull();
  });

  it('lit la TVA indiquée : un taux unique ou des montants nets par taux', () => {
    expect(parseBillInformation('//S1/10/F1/32/8.1')?.vat).toEqual([{ ratePercent: 8.1, netAmountCents: null }]);
    expect(parseBillInformation('//S1/10/F1/32/8.1:1000;2.6:51.5')?.vat).toEqual([
      { ratePercent: 8.1, netAmountCents: 100000 },
      { ratePercent: 2.6, netAmountCents: 5150 },
    ]);
  });

  it('présente les références par groupes', () => {
    expect(formatPaymentReference('QRR', '210000000003139471430009017')).toBe('21 00000 00003 13947 14300 09017');
    expect(formatPaymentReference('SCOR', 'RF18539007547034')).toBe('RF18 5390 0754 7034');
  });
});
