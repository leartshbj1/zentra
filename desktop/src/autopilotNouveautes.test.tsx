// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutopilotToday } from './AutopilotToday';
import { AutopilotNotifications } from './AutopilotNotifications';
import { isFresh, markSeen, requestAutopilotFocus, seenItems } from './autopilotSeen';
import type { AutopilotActionCard } from './AutopilotActionList';
import type { AutopilotSignalCard } from './AutopilotSignalList';
import type { AutopilotView } from './autopilotView';
import type { JournalEntry } from './autopilotJournal';

vi.mock('./language', () => ({ useAppLanguage: () => 'fr', getAppLanguage: () => 'fr', getAppLocale: () => 'fr-CH', t: (text: string) => text }));

const now = Math.floor(Date.now() / 1000);
const state = { status: 'ready', canManage: true, consent: null, saving: false, error: null, activity: null, readingReviews: false, reviewsUnavailable: false,
  reviews: { organizationId: 'org', nextCursor: null, items: [] } } as unknown as AutopilotView;
const internal: AutopilotActionCard = { key: 'stock:s1', title: 'Stock bas · Vitrificateur', detail: '2 restants', actions: [{ id: 'order', label: 'Préparer la commande', primary: true }] };
const mcpQuote: AutopilotActionCard = { key: 'inbox:in_1', title: 'Devis demandé par MCP à préparer', detail: 'Garage Dupont',
  arrival: { at: now - 240, origin: 'par un assistant (MCP)', what: 'Devis', subject: 'Devis à préparer', from: 'Garage Dupont', lines: ['3 pce · Pneus hiver'] },
  actions: [{ id: 'inbox-quote', label: 'Créer le devis', primary: true }, { id: 'inbox-reject', label: 'Refuser' }] };
const oldSignal: AutopilotSignalCard = { sourceId: 'm1', receivedAt: now - 10 * 86_400, title: 'Paiement annoncé', evidence: '« Payé ce matin. »', sender: 'Résidence Bellevue', actionLabel: 'Enregistrer le paiement' };

const roots: { root: Root; host: HTMLDivElement }[] = [];
beforeEach(() => { localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { for (const { root, host } of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });
async function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({ root, host });
  await act(async () => root.render(element));
  return { host, root };
}
const today = (followUps: AutopilotActionCard[], signals: AutopilotSignalCard[] = []) =>
  <AutopilotToday language="fr" organizationId="org" observation={false} onOpen={() => undefined} onSettings={() => undefined} onOpenSource={async () => undefined}
    state={state} signals={signals} followUps={followUps} onFollowUp={() => undefined} />;
const rows = (host: HTMLElement) => [...host.querySelectorAll('.autopilot-today__queue li')].map(row => row.textContent ?? '');

describe('autopilotSeen', () => {
  it('keeps an arrival new until it is opened, three days at most, per company', () => {
    expect(isFresh('a', now - 60, {})).toBe(true);
    expect(isFresh('a', now - 4 * 86_400, {})).toBe(false);
    expect(isFresh('a', undefined, {})).toBe(false);
    markSeen('org', ['a']);
    expect(isFresh('a', now - 60, seenItems('org'))).toBe(false);
    expect(seenItems('other')).toEqual({});
  });
});

describe('Aujourd’hui: what arrived comes first', () => {
  it('puts a quote dropped through MCP at the top, marked new, with where it came from', async () => {
    const { host } = await mount(today([internal, mcpQuote], [oldSignal]));
    const list = rows(host);
    expect(list[0]).toContain('Devis · par un assistant (MCP)');
    expect(list[0]).toContain('Garage Dupont');
    expect(list[0]).toMatch(/4\smin/);
    expect(host.querySelector('.autopilot-today__group[data-fresh] h3')?.textContent).toContain('Nouveau');
    // An old mail signal is not new: it keeps its usual place, before the internal card.
    expect(list[1]).toContain('Paiement annoncé');
    expect(list[2]).toContain('Stock bas');
    const head = host.querySelector('.autopilot-today__focus-head')?.textContent ?? '';
    expect(head).toContain('Nouveau');
    expect(head).toContain('Reçu par un assistant (MCP)');
    expect(host.querySelector('.autopilot-today__asked')?.textContent).toContain('3 pce · Pneus hiver');
  });

  it('counts the opened item as read, but keeps it in place for the visit', async () => {
    const { host } = await mount(today([internal, mcpQuote]));
    expect(seenItems('org')['followup:inbox:in_1']).toBeGreaterThan(0);
    expect(rows(host)[0]).toContain('Garage Dupont');
  });

  it('is not new any more on the next visit once opened', async () => {
    markSeen('org', ['followup:inbox:in_1']);
    const { host } = await mount(today([internal, mcpQuote]));
    expect(host.querySelector('.autopilot-today__group[data-fresh]')).toBeNull();
    expect(rows(host)[0]).toContain('Stock bas');
  });

  it('opens the item a notification asked for', async () => {
    const second: AutopilotActionCard = { ...mcpQuote, key: 'inbox:in_2', arrival: { ...mcpQuote.arrival!, at: now - 3600, from: 'Menuiserie Favre' } };
    requestAutopilotFocus('followup:inbox:in_2');
    const { host } = await mount(today([internal, mcpQuote, second]));
    expect(host.querySelector('.autopilot-today__focus-head h3')?.textContent).toBe('Menuiserie Favre');
    expect(host.querySelector('.autopilot-today__queue button[aria-current]')?.textContent).toContain('Menuiserie Favre');
  });
});

describe('Notifications', () => {
  const entry = (id: string, label: string, minutes: number): JournalEntry =>
    ({ id, key: id, actionLabel: label, title: 'CHF 486.00 reçu de Résidence Bellevue', detail: '', ok: true, at: new Date(Date.now() - minutes * 60_000).toISOString() });
  const entries = [
    { id: 'followup:inbox:in_1', type: 'followup', card: mcpQuote, kind: 'Devis', title: 'Garage Dupont', sub: 'Devis à préparer', at: now - 240, origin: 'par un assistant (MCP)' },
    { id: 'signal:m1', type: 'signal', card: oldSignal, kind: 'D’après un e-mail', title: 'Paiement annoncé', at: oldSignal.receivedAt },
    { id: 'brief:tools', type: 'brief', destination: 'tools', count: 2, kind: 'Gestion', title: 'Classements à vérifier' },
  ] as const;

  it('shows a dot while something new was never opened, lists recent arrivals and what Zentra did', async () => {
    const onOpen = vi.fn();
    const { host } = await mount(<AutopilotNotifications language="fr" organizationId="org" entries={entries as never} autoLabel="validé automatiquement"
      journal={[entry('j1', 'Confirmer · validé automatiquement', 5), entry('j2', 'Confirmer', 30)]} onOpen={onOpen} onOpenHistory={() => undefined} />);
    const bell = host.querySelector<HTMLButtonElement>('.autopilot-bell')!;
    expect(bell.getAttribute('aria-label')).toBe('Notifications, 2 nouvelle(s)');
    expect(host.querySelector('.autopilot-bell__dot')).not.toBeNull();
    await act(async () => bell.click());
    const sections = [...host.querySelectorAll('.autopilot-notices__scroll section')];
    expect(sections.map(section => section.querySelector('h3')?.textContent)).toEqual(['Arrivé', 'Fait par Zentra']);
    // Older than three days, the mail signal waits in "Aujourd'hui" only; brief rows never arrive.
    expect(sections[0].querySelectorAll('li')).toHaveLength(1);
    expect(sections[0].textContent).toContain('Nouveau · Devis · par un assistant (MCP)');
    expect(sections[1].querySelectorAll('li')).toHaveLength(2);
    // Opening the panel reads what Zentra did alone; the arrival stays new until opened.
    expect(seenItems('org')['done:j1']).toBeGreaterThan(0);
    await act(async () => sections[0].querySelector('button')!.click());
    expect(onOpen).toHaveBeenCalledWith('followup:inbox:in_1');
  });

  it('marks everything read in one click and loses its dot', async () => {
    const { host } = await mount(<AutopilotNotifications language="fr" organizationId="org" entries={entries as never} autoLabel="validé automatiquement"
      journal={[]} onOpen={() => undefined} onOpenHistory={() => undefined} />);
    await act(async () => host.querySelector<HTMLButtonElement>('.autopilot-bell')!.click());
    const readAll = [...host.querySelectorAll('button')].find(button => button.textContent === 'Tout marquer comme lu')!;
    await act(async () => readAll.click());
    expect(host.querySelector('.autopilot-bell__dot')).toBeNull();
    expect(host.querySelector('.autopilot-bell')?.getAttribute('aria-label')).toBe('Notifications');
  });

  it('says so calmly when nothing is new', async () => {
    const { host } = await mount(<AutopilotNotifications language="fr" organizationId="org" entries={[]} autoLabel="" journal={[]} onOpen={() => undefined} onOpenHistory={() => undefined} />);
    expect(host.querySelector('.autopilot-bell__dot')).toBeNull();
    await act(async () => host.querySelector<HTMLButtonElement>('.autopilot-bell')!.click());
    expect(host.querySelector('.autopilot-notices__empty')?.textContent).toContain('Rien de nouveau');
  });
});
