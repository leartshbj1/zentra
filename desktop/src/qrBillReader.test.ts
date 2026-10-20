import { describe, expect, it } from 'vitest';
import { firstQrBill, qrBillReadMessage } from './qrBillReader';

const SPC = [
  'SPC', '0200', '1', 'CH5800791123000889012', 'S', 'Swisscom (Schweiz) AG', 'Alte Tiefenaustrasse', '6', '3048', 'Worblaufen', 'CH',
  '', '', '', '', '', '', '', '89.90', 'CHF', '', '', '', '', '', '', '', 'NON', '', 'Facture 118', 'EPD',
].join('\n');

describe('choix de la QR-facture parmi les codes trouvés', () => {
  it('garde le premier code SPC valide, même après un autre code QR', () => {
    const result = firstQrBill(['https://swisscom.ch/app', SPC]);
    expect(result.ok && result.bill.amountCents).toBe(8990);
  });

  it('explique pourquoi aucune facture n’a pu être lue', () => {
    expect(firstQrBill([])).toEqual({ ok: false, reason: 'no_qr' });
    expect(firstQrBill(['https://example.ch'])).toEqual({ ok: false, reason: 'not_swiss_qr' });
    expect(firstQrBill(['https://example.ch', SPC.replace('CH5800791123000889012', 'CH5800791123000889013')])).toEqual({ ok: false, reason: 'invalid_iban' });
    expect(qrBillReadMessage('no_qr')).toMatch(/Aucune QR-facture/);
  });
});
