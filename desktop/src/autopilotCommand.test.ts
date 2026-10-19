// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { commandHistory, commandLines, commandReadingFrom, findInvoice, findParty, rememberCommand, searchView, type CommandReading } from './autopilotCommand';
import type { CatalogItem, Client, Invoice, Supplier } from './types';

const reading = (values: Partial<CommandReading>): CommandReading => ({ action: 'create_quote', party: 'Dupont SA', lines: [], date: null, time: null, amountCents: null,
  currency: null, quoteReference: null, invoiceReference: null, text: '', ...values });
const item = (id: string, name: string, unit = 'pce') => ({ id, name, unit, salesPriceCents: 8900, vatBp: 810 }) as CatalogItem;

describe('typed commands', () => {
  beforeEach(() => window.localStorage.clear());
  it('reads only well-formed readings', () => {
    const raw = { ...reading({}), lines: [{ evidence: '3 Zentra Pro', quantityMilli: 3000, unit: null }] } as unknown as Record<string, unknown>;
    expect(commandReadingFrom(raw)?.lines).toHaveLength(1);
    expect(commandReadingFrom({ ...raw, action: 'drop' })).toBeNull();
    expect(commandReadingFrom({ ...raw, date: 'demain' })).toBeNull();
  });
  it('finds the party by name, company, then start of the name, never by a guess', () => {
    const clients = [{ id: 'c1', name: 'Dupont', company: 'Dupont SA' }, { id: 'c2', name: 'Martin', company: '' }, { id: 'c3', name: 'Martinez', company: '' }] as Client[];
    expect(findParty('dupont sa', clients, [])).toMatchObject({ kind: 'client', client: { id: 'c1' } });
    expect(findParty('Martin', clients, [])).toMatchObject({ client: { id: 'c2' } });
    expect(findParty('Mart', clients, [])).toBeNull();
    expect(findParty('Acme', clients, [{ id: 's1', name: 'Acme SA' } as Supplier])).toMatchObject({ kind: 'supplier' });
  });
  it('turns each element into a catalogue line, keeping unknown ones as typed text', () => {
    const { lines, missing } = commandLines(reading({ lines: [{ evidence: '3 Zentra Pro', quantityMilli: 3000, unit: null }, { evidence: 'installation', quantityMilli: 2000, unit: 'hour' },
      { evidence: 'peinture', quantityMilli: null, unit: null }] }), [item('a', 'Zentra Pro'), item('h', 'Heure de travail', 'h')], () => 'x');
    expect(lines.map(line => [line.catalogItemId, line.quantity])).toEqual([['a', 3], ['h', 2], [null, 1]]);
    expect(missing).toEqual(['peinture']);
  });
  it('finds invoices, search targets and keeps the last 20 sentences', () => {
    expect(findInvoice('f-2026- 0012', [{ id: 'i', number: 'F-2026-0012' } as Invoice])?.id).toBe('i');
    expect(searchView('Montre les factures impayées')).toBe('invoices');
    for (let index = 0; index < 25; index++) rememberCommand('phrase ' + index);
    rememberCommand('phrase 3');
    expect(commandHistory()[0]).toBe('phrase 3');
    expect(commandHistory()).toHaveLength(20);
  });
});
describe('examples', () => {
  it('are written in each app language', async () => {
    const { COMMAND_EXAMPLES } = await import('./autopilotCommand');
    expect(COMMAND_EXAMPLES.fr.some(example => /Offerte|Termin/.test(example))).toBe(false);
    expect(Object.values(COMMAND_EXAMPLES).every(list => list.length === 7)).toBe(true);
  });
});
