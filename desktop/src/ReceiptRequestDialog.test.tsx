// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MissingReceipt } from './paymentSafety';
import type { BankMovement, Employee } from './types';

const api = vi.hoisted(() => ({ receiptRequestChannel: vi.fn(), sendReceiptRequest: vi.fn() }));
vi.mock('./bridge', () => ({ desktopApi: api }));
vi.mock('./language', () => ({
  useAppLanguage: () => 'fr',
  getAppLocale: () => 'fr-CH',
  t: (source: string, values?: Record<string, string | number>) => source.replace(/\{(\w+)\}/g, (_, key: string) => String(values?.[key] ?? `{${key}}`)),
}));
const { ReceiptRequestDialog } = await import('./PaymentSafetyParts');

const receipt: MissingReceipt = { reason: 'unlinked', ageDays: 22, movement: { id: 'movement-42', amountCents: 8_450, currency: 'CHF', bookingDate: '2026-10-03', valueDate: '2026-10-03', counterpartyName: 'Coop Bau+Hobby Bulle', unstructured: '', reference: '' } as BankMovement };
const luca = { id: 'e1', name: 'Luca Rossi', email: 'luca.rossi@example.invalid', employmentEnd: '' } as unknown as Employee;
let root: Root, host: HTMLDivElement;
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); api.receiptRequestChannel.mockReset(); api.sendReceiptRequest.mockReset(); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
async function open(onSent = vi.fn()) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ReceiptRequestDialog receipt={receipt} employees={[luca]} companyName="Atelier du Léman" onClose={() => {}} onSent={onSent} />));
  await act(async () => { await Promise.resolve(); });
  return onSent;
}
const button = (label: string) => [...document.querySelectorAll('button')].find((node) => node.textContent === label);

it('sends the edited request through the connected company mailbox with one click', async () => {
  api.receiptRequestChannel.mockResolvedValue({ kind: 'company', scope: 's', connectionId: '00000000-0000-4000-8000-000000000001', fromEmail: 'bureau@example.invalid' });
  api.sendReceiptRequest.mockResolvedValue({ status: 'accepted', replayed: false });
  const onSent = await open();
  expect(document.body.textContent).toContain('Envoyé depuis bureau@example.invalid');
  const textarea = document.querySelector('textarea')!;
  expect(textarea.value).toContain('Bonjour Luca,');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Bonjour Luca, le ticket Coop svp. Merci');
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('Envoyer')!.click());
  expect(api.sendReceiptRequest).toHaveBeenCalledTimes(1);
  const [channel, input] = api.sendReceiptRequest.mock.calls[0];
  expect(channel.kind).toBe('company');
  expect(input).toMatchObject({ reference: 'movement-42', recipient: 'luca.rossi@example.invalid', body: 'Bonjour Luca, le ticket Coop svp. Merci' });
  expect(input.subject).toContain('84.50');
  expect(onSent).toHaveBeenCalledWith(luca, 'sent');
});

it('falls back to a draft in the mail app when no mailbox is connected, and never calls the send', async () => {
  api.receiptRequestChannel.mockResolvedValue(null);
  await open();
  expect(button('Envoyer')).toBeUndefined();
  const link = [...document.querySelectorAll('a')].find((node) => node.textContent === 'Ouvrir le brouillon dans la messagerie')!;
  expect(link.getAttribute('href')).toMatch(/^mailto:luca\.rossi%40example\.invalid\?subject=/);
  expect(api.sendReceiptRequest).not.toHaveBeenCalled();
});

it('keeps the message and offers the draft when the send is refused', async () => {
  api.receiptRequestChannel.mockResolvedValue({ kind: 'device', scope: 's', fromEmail: 'bureau@example.invalid' });
  api.sendReceiptRequest.mockRejectedValue(new Error('Cette action n’est pas disponible.'));
  const onSent = await open();
  await act(async () => button('Envoyer')!.click());
  expect(document.querySelector('[role=alert]')?.textContent).toContain('ouvrir le message dans votre messagerie');
  expect(onSent).not.toHaveBeenCalled();
  expect([...document.querySelectorAll('a')].some((node) => node.textContent === 'Ouvrir dans ma messagerie')).toBe(true);
});
