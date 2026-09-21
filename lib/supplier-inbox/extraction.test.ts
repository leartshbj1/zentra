import { expect, it } from 'vitest';
import {
  canonicalDate,
  amountCents,
  invoiceCandidates,
  extractInvoice,
  extractionIssues,
  emptyExtraction,
  extractionInput,
} from './extraction';
import type { DecisionInput } from '@/lib/automation/types';
import { JevDecisionProvider } from '@/lib/automation/provider';
const source = `Fournisseur: Acme SA\nFacture No INV-2026-19\nDate de facture: 20.09.2026\nÉchéance: 20.10.2026\nLogiciels CHF\nHors taxe 100.00\nTVA 8.10 % 8.10\nTotal CHF 108.10`;
it('parses Swiss amounts exactly, and rejects impossible calendar dates', () => {
  expect(amountCents('1’234.50')).toBe(123450);
  expect(amountCents('1 234,50')).toBe(123450);
  expect(amountCents('not an amount')).toBeNull();
  expect(canonicalDate('31.02.2026')).toBeNull();
  expect(canonicalDate('2026-99-99')).toBeNull();
  expect(canonicalDate('20.09.2026')).toBe('2026-09-20');
});
it('only supplies source-grounded candidates with an abstention option', () => {
  const c = invoiceCandidates(source);
  expect(c.reference[0].value).toBe('INV-2026-19');
  expect(c.totalCents.map((c) => c.value)).toContain(10810);
  const { input } = extractionInput(source, 'Zentra Test');
  for (const [key, q] of Object.entries(input.questions))
    if (!['kind', 'category'].includes(key))
      expect(q.options.absent).toBeTruthy();
});
it.each([
  ['FACTURE\nN° ZT-QA-20260921-02', 'ZT-QA-20260921-02'],
  ['Référence :\nFAC-2026-091', 'FAC-2026-091'],
  ['Invoice\nNumber INV-908', 'INV-908'],
  ['Rechnung\nNr. RE-2026-8', 'RE-2026-8'],
  ['Rechnungsnummer: RE-2026-84', 'RE-2026-84'],
  ['Fattura\nn. IT-234', 'IT-234'],
])('offers the printed reference across PDF line breaks: %s', (text, value) => {
  expect(invoiceCandidates(text).reference.map(c => c.value)).toContain(value);
});
it('does not manufacture a reference from a date or a bare number', () => {
  expect(invoiceCandidates('FACTURE\n21.09.2026\nCHF 100.00\nCommande 1234').reference).toEqual([]);
  expect(invoiceCandidates('21.09.2026\n123456').reference).toEqual([]);
});
const provider = {
  decide: async (input: DecisionInput) => ({
    answers: Object.fromEntries(
      Object.entries(input.questions).map(([key, q]) => {
        const wanted: Record<string, string> = {
          kind: 'supplier_invoice',
          category: 'software',
          suppliername: 'Acme SA',
          reference: 'INV-2026-19',
          invoicedate: '2026-09-20',
          duedate: '2026-10-20',
          currency: 'CHF',
          netcents: '10000',
          vatcents: '810',
          totalcents: '10810',
          vatbp: '810',
        };
        const choice = ['kind', 'category'].includes(key)
          ? wanted[key]
          : Object.keys(q.options).find((k) =>
              q.options[k].startsWith(wanted[key] + ' —'),
            ) || 'absent';
        return [
          key,
          {
            choice,
            confidence: 0.99,
            probabilities: Object.fromEntries(
              Object.keys(q.options).map((k) => [k, k === choice ? 1 : 0]),
            ),
          },
        ];
      }),
    ),
    provider: 'fixture',
    model: 'fixture',
    latencyMs: 1,
    usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
  }),
};
it('extracts exact amounts and evidence through typed choices', async () => {
  const value = await extractInvoice(source, 'Zentra Test', provider);
  expect(value).toMatchObject({
    kind: 'supplier_invoice',
    totalCents: 10810,
    vatCents: 810,
    netCents: 10000,
    vatBp: 810,
  });
  expect(value.issues).toEqual([]);
  expect(value.evidence.totalCents).toContain('108.10');
});
it('missing values, inconsistent tax and totals always require review', async () => {
  const value = await extractInvoice(source, 'Zentra Test', provider);
  expect(extractionIssues({ ...value, vatCents: 700 })).not.toEqual([]);
  expect(extractionIssues({ ...value, currency: 'EUR' })).not.toEqual([]);
  expect(extractionIssues({ ...value, reference: null })).not.toEqual([]);
  expect(extractionIssues({ ...value, confidence: 0.94 })).not.toEqual([]);
  expect(emptyExtraction('scan').totalCents).toBeNull();
});
it('does not replace a provider failure with invented zeroes', async () => {
  await expect(
    extractInvoice(source, 'Test', {
      decide: async () => {
        throw Error('offline');
      },
    }),
  ).rejects.toThrow('offline');
});
it('passes the real provider request and response contract without dropping the invoice text', async () => {
  let sent = false;
  const client = new JevDecisionProvider(
    'synthetic-test-key',
    async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      sent = true;
      expect(body.state.excerpt_1).toContain('Hors taxe 100.00');
      const fixture = await provider.decide(
        extractionInput(source, 'Zentra Test').input,
      );
      return Response.json({
        ...fixture,
        answers: Object.fromEntries(
          Object.entries(fixture.answers).map(([key, value]) => [
            key,
            { type: 'choice', ...value },
          ]),
        ),
      });
    },
  );
  expect((await extractInvoice(source, 'Zentra Test', client)).totalCents).toBe(
    10810,
  );
  expect(sent).toBe(true);
});
it('keeps a dense invoice inside the provider request limit', async () => {
  const dense=Array.from({length:100},(_,i)=>`Fournisseur: Société ${i} ${'x'.repeat(90)}\nFacture No INV-${i}-${'y'.repeat(75)}\nDate ${String(i%28+1).padStart(2,'0')}.09.2026 CHF EUR USD GBP ${i+20}.00 ${i%12+1}.10 %`).join('\n');
  let sent=false;
  const client=new JevDecisionProvider('synthetic',async(_url,init)=>{sent=true;expect(String(init?.body).length).toBeLessThanOrEqual(32000);return new Response('',{status:400});});
  await expect(client.decide(extractionInput(dense,'Test').input)).rejects.toThrow();
  expect(sent).toBe(true);
});
