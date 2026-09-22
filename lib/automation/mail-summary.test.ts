import { expect, it } from 'vitest';
import { summarizeReceivedMail } from './mail-summary';

it('extracts received facts with their original wording, numbers and negations', () => {
  const body =
    'Bonjour,\nMerci de ne pas payer la facture 2026-17 : elle est annulée.\nLe nouveau rendez-vous est le 24.09 à 14:30, avenue du Test 12.\nLe montant de CHF 540.50 reste contesté.\nMerci de confirmer par retour de mail.';
  const result = summarizeReceivedMail({
    subject: 'Correction',
    sender: 'client@example.test',
    body,
    attachments: ['Avoir.pdf'],
  });
  expect(result.excerpts.map((e) => e.text).join('\n')).toContain(
    'ne pas payer',
  );
  expect(result.excerpts.map((e) => e.text).join('\n')).toContain(
    'CHF 540.50 reste contesté',
  );
  for (const e of result.excerpts)
    expect(body.slice(e.start, e.end)).toBe(e.text);
  expect(result.attachments).toEqual(['Avoir.pdf']);
});
it('does not invent missing facts or repeat copied lines', () => {
  const body =
    'Pourriez-vous nous rappeler à propos de la commande ?\nPourriez-vous nous rappeler à propos de la commande ?';
  const result = summarizeReceivedMail({
    subject: 'Question',
    sender: '',
    body,
    attachments: [],
  });
  expect(result.excerpts).toHaveLength(1);
  expect(result.sender).toBe('');
  expect(result.attachments).toEqual([]);
  expect(
    summarizeReceivedMail({
      subject: '',
      sender: '',
      body: '',
      attachments: [],
    }).excerpts,
  ).toEqual([]);
});
it('bounds long messages and preserves exact source offsets for excerpts', () => {
  const body = Array.from(
    { length: 300 },
    (_, i) => `  Demande ${i} : ${'un texte reçu '.repeat(100)}  `,
  ).join('\n');
  const result = summarizeReceivedMail({
    subject: 'Long',
    sender: 'test@example.test',
    body,
    attachments: [],
  });
  expect(result.truncated).toBe(true);
  expect(result.excerpts.length).toBeLessThanOrEqual(5);
  expect(
    result.excerpts.reduce((sum, e) => sum + e.text.length, 0),
  ).toBeLessThanOrEqual(2400);
  for (const e of result.excerpts)
    expect(body.slice(e.start, e.end)).toBe(e.text);
});
