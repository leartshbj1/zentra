// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopilotDoneList } from './AutopilotDoneList';
import { AutopilotJournalList } from './AutopilotJournalList';
import type { JournalEntry } from './autopilotJournal';

const locale = vi.hoisted(() => ({ language: 'fr' }));
vi.mock('./language', () => ({ useAppLanguage: () => locale.language, getAppLocale: () => `${locale.language}-CH`, t: (text: string) => text }));

const now = new Date(2026, 9, 20, 15, 0);
const entry = (id: string, ok: boolean | null, hours: number, extra: Partial<JournalEntry> = {}): JournalEntry =>
  ({ id, key: id, actionLabel: 'Devis créé', title: 'Dupont SA · D-2026-0008', detail: '', ok, at: new Date(2026, 9, 20, hours).toISOString(), ...extra });

const roots: { root: Root; host: HTMLDivElement }[] = [];
beforeEach(() => { locale.language = 'fr'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });
async function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({ root, host });
  await act(async () => root.render(element));
  return host;
}

describe('AutopilotDoneList', () => {
  it('folds each really done card into a check, newest first, with its count', async () => {
    const host = await mount(<AutopilotDoneList now={now} entries={[entry('a', true, 9), entry('b', null, 10), entry('c', false, 11), entry('d', true, 12, { actionLabel: 'Devis envoyé' })]} />);
    expect(host.querySelector('h3')?.textContent).toBe('Fait aujourd’hui : 2');
    const rows = [...host.querySelectorAll('li')].map(row => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('Devis envoyé · Dupont SA · D-2026-0008');
    expect(rows[1]).toContain('Devis créé · Dupont SA · D-2026-0008');
  });

  it('offers undo only when the inverse is known', async () => {
    const onUndo = vi.fn();
    const host = await mount(<AutopilotDoneList now={now} onUndo={onUndo} entries={[entry('a', true, 9, { undo: { kind: 'quote-status', quoteId: 'q', status: 'sent' } }), entry('b', true, 10)]} />);
    const buttons = host.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    await act(async () => buttons[0].click());
    expect(onUndo).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
  });

  it.each(['de', 'it', 'en'])('says it in %s', async language => {
    locale.language = language;
    const host = await mount(<AutopilotDoneList now={now} entries={[entry('a', true, 9)]} />);
    expect(host.querySelector('h3')?.textContent).toBe({ de: 'Heute erledigt: 1', it: 'Fatto oggi: 1', en: 'Done today: 1' }[language]);
  });

  it('never lists the same entry in "Fait aujourd’hui" and in the history', async () => {
    const yesterday = { ...entry('y', true, 9), at: new Date(2026, 9, 19, 9).toISOString(), actionLabel: 'Devis envoyé hier' };
    const entries = [entry('a', true, 9), entry('b', null, 10, { actionLabel: 'Ouvert' }), entry('c', false, 11, { actionLabel: 'Échoué' }), yesterday];
    const host = await mount(<><AutopilotDoneList now={now} entries={entries} /><AutopilotJournalList now={now} entries={entries} /></>);
    const done = [...host.querySelectorAll('.quote-autopilot__done li')].map(row => row.textContent ?? '');
    const history = [...host.querySelectorAll('.quote-autopilot__journal li')].map(row => row.textContent ?? '');
    expect(done).toHaveLength(1);
    expect(history).toHaveLength(3);
    expect(history.some(text => text.startsWith('Devis créé'))).toBe(false);
    expect(history.join('|')).toContain('Devis envoyé hier');
  });

  it('hides the history when everything in it is already listed above', async () => {
    const host = await mount(<AutopilotJournalList now={now} entries={[entry('a', true, 9)]} />);
    expect(host.innerHTML).toBe('');
  });

  it('shows nothing before anything is done', async () => {
    const host = await mount(<AutopilotDoneList now={now} entries={[entry('b', null, 10)]} />);
    expect(host.innerHTML).toBe('');
  });
});
