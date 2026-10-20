// Draws a fictitious Swiss QR-bill (payment part only) for the ERP captures.
// Excluded from production: the captures import it from the browser harness.
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { QRCodeCanvas } from 'qrcode.react';

export const sampleQrPayload = [
  'SPC', '0200', '1', 'CH4431999123000889012', 'S', 'Scierie du Jura Sàrl', 'Route de Moutier', '14', '2800', 'Delémont', 'CH',
  '', '', '', '', '', '', '', '949.77', 'CHF', 'S', 'Atelier du Léman', 'Rue de test', '1', '1000', 'Lausanne', 'CH',
  'QRR', '210000000003139471430009017', 'Planches de chêne', 'EPD', '//S1/10/10201409/11/261015/32/8.1/40/0:30',
].join('\n');

/** PNG data URL of a white sheet holding the QR code, as a phone photo would. */
export async function sampleQrBillPng(): Promise<string> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  flushSync(() => root.render(<QRCodeCanvas value={sampleQrPayload} level="M" size={360} marginSize={4} />));
  const qr = host.querySelector('canvas')!;
  const sheet = document.createElement('canvas');
  sheet.width = 900;
  sheet.height = 700;
  const context = sheet.getContext('2d')!;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, sheet.width, sheet.height);
  context.fillStyle = '#222';
  context.font = '24px sans-serif';
  context.fillText('Section paiement', 40, 60);
  context.drawImage(qr, 40, 100, 400, 400);
  const url = sheet.toDataURL('image/png');
  root.unmount();
  host.remove();
  return url;
}
