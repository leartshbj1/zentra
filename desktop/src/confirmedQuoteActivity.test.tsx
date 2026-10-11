// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutomationJournal } from './AutomationJournal';
import { confirmedQuoteActivityCopy, type ConfirmedQuoteActivityPage } from './confirmedQuoteActivity';

const locale = vi.hoisted(() => ({ language: 'fr' }));
vi.mock('./language', () => ({ useAppLanguage: () => locale.language }));
const firstQuote = '7418f947-06af-4dfb-84d0-0f2eae5fb946';
const secondQuote = 'b8c6975a-6f44-4b15-a579-068b072d95f1';
const page: ConfirmedQuoteActivityPage = { organizationId: 'company-a', nextCursor: null, items: [
  { activityId: 'activity:old', proposalId: 'proposal:old', quoteId: firstQuote, confirmedAt: 1791712800, kind: 'quote_draft_created', requiresHumanValidation: true },
  { activityId: 'activity:new', proposalId: 'proposal:new', quoteId: secondQuote, confirmedAt: 1791716400, kind: 'quote_draft_created', requiresHumanValidation: true },
] };
const run = { id: 'workflow', title: 'Suivi existant', state: 'completed', createdAt: 1791713000, updatedAt: 1791713000 };
const renderRun = () => <span>{run.title}</span>;
const mounted: { root: Root; host: HTMLDivElement }[] = [];
beforeEach(() => { locale.language = 'fr'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) { await act(async () => root.unmount()); host.remove(); }
  vi.unstubAllGlobals();
});
async function mount(element: ReactNode) {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); mounted.push({ root, host });
  await act(async () => root.render(element)); return { root, host };
}
const opens = (host: HTMLElement) => Array.from(host.querySelectorAll<HTMLButtonElement>('.automation-journal__direct button'));
const filter = (host: HTMLElement, title: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('.automation-journal__filters button')).find(button => button.textContent === title)!;

it('keeps the legacy journal unchanged without the optional page', () => {
  const html = renderToStaticMarkup(<AutomationJournal runs={[run]} renderRun={renderRun} organizationId="company-a" />);
  expect(html).toContain(run.title); expect(html).not.toContain('Devis préparé'); expect(html).not.toContain('>Devis</button>');
});

it('opens the exact newest and oldest quote, never a proposal or activity id', async () => {
  const openQuote = vi.fn();
  const { host } = await mount(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={page} openQuote={openQuote} />);
  expect(opens(host)).toHaveLength(2);
  await act(async () => opens(host)[0].click()); expect(openQuote).toHaveBeenLastCalledWith(secondQuote);
  await act(async () => opens(host)[1].click()); expect(openQuote).toHaveBeenLastCalledWith(firstQuote);
  expect(openQuote).toHaveBeenCalledTimes(2);
  expect(host.querySelector('time')?.getAttribute('datetime')).toBe(new Date(page.items[1].confirmedAt * 1000).toISOString());
  expect(host.textContent).not.toMatch(/Brouillon|À vérifier|Émis|Envoyé/);
  expect(host.textContent).not.toContain('proposal:'); expect(host.textContent).not.toContain('activity:');
});

it('does not offer an opening action without a destination callback', () => {
  const html = renderToStaticMarkup(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={page} />);
  expect(html).toContain('Devis préparé'); expect(html).not.toContain('Ouvrir le devis');
});

it.each(['company-b', undefined])('hides a retained page and all opening actions for current scope %s', organizationId => {
  const html = renderToStaticMarkup(<AutomationJournal runs={[]} renderRun={renderRun} organizationId={organizationId} confirmedQuotes={page} openQuote={vi.fn()} />);
  expect(html).not.toContain('Devis préparé'); expect(html).not.toContain('Ouvrir le devis');
});

it('removes old rows and callbacks on a company replacement, then opens only the new company quote', async () => {
  const openQuote = vi.fn();
  const { host, root } = await mount(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={page} openQuote={openQuote} />);
  await act(async () => root.render(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-b" confirmedQuotes={page} openQuote={openQuote} />));
  expect(opens(host)).toHaveLength(0); expect(host.textContent).not.toContain('Devis préparé');
  const replacement = { ...page, organizationId: 'company-b', items: [page.items[0]] };
  await act(async () => root.render(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-b" confirmedQuotes={replacement} openQuote={openQuote} />));
  await act(async () => opens(host)[0].click()); expect(openQuote).toHaveBeenCalledExactlyOnceWith(firstQuote);
});

it('filters supplied quotes and returns to all when the optional feature is removed', async () => {
  const { host, root } = await mount(<AutomationJournal runs={[run]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={page} />);
  expect(host.textContent).toContain(run.title);
  await act(async () => filter(host, 'Devis').click());
  expect(filter(host, 'Devis').getAttribute('aria-pressed')).toBe('true'); expect(host.textContent).not.toContain(run.title);
  await act(async () => root.render(<AutomationJournal runs={[run]} renderRun={renderRun} organizationId="company-a" />));
  expect(filter(host, 'Devis')).toBeUndefined(); expect(host.textContent).toContain(run.title);
  expect(host.querySelector('.automation-journal__filters button')?.getAttribute('aria-pressed')).toBe('true');
});

it('renders one row for an exact replay and none for conflicting proof identities', () => {
  const render = (items: ConfirmedQuoteActivityPage['items']) => renderToStaticMarkup(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={{ ...page, items }} openQuote={vi.fn()} />);
  expect(render([page.items[0], { ...page.items[0] }]).match(/automation-journal__quote/g)).toHaveLength(1);
  expect(render([page.items[0], { ...page.items[0], quoteId: secondQuote }])).not.toContain('Devis préparé');
});

it.each(['fr', 'de', 'it', 'en'])('renders the historical row, filter and exact callback in %s', async language => {
  locale.language = language; const copy = confirmedQuoteActivityCopy(language); const openQuote = vi.fn();
  const { host } = await mount(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={{ ...page, items: [page.items[0]] }} openQuote={openQuote} />);
  expect(host.textContent).toContain(copy.prepared); expect(filter(host, copy.filter)).toBeDefined();
  expect(opens(host)[0].textContent).toBe(copy.open); await act(async () => opens(host)[0].click());
  expect(openQuote).toHaveBeenCalledExactlyOnceWith(firstQuote);
});

it('limits a supplied page to thirty visible rows and reveals the remainder locally', async () => {
  const items = Array.from({ length: 31 }, (_, index) => ({ ...page.items[0], activityId: `activity:${index}`, proposalId: `proposal:${index}`, quoteId: `7418f947-06af-4dfb-84d0-${String(index).padStart(12, '0')}`, confirmedAt: 1791712800 + index }));
  const { host } = await mount(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={{ ...page, items }} openQuote={vi.fn()} />);
  expect(opens(host)).toHaveLength(30);
  const more = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Afficher la suite')!;
  expect(more).toBeDefined(); await act(async () => more.click()); expect(opens(host)).toHaveLength(31);
});

it.each(['fr', 'de', 'it', 'en'])('distinguishes unavailable quote activity from a valid empty page in %s', language => {
  locale.language = language;
  const render = (confirmedQuotes: ConfirmedQuoteActivityPage | null) => renderToStaticMarkup(<AutomationJournal runs={[]} renderRun={renderRun} organizationId="company-a" confirmedQuotes={confirmedQuotes} />);
  const copy = confirmedQuoteActivityCopy(language);
  expect(render(null)).toContain(copy.unavailable);
  expect(render(null)).not.toContain('automation-journal__empty');
  expect(render({ ...page, items: [] })).not.toContain(copy.unavailable);
  expect(render({ ...page, items: [] })).toContain('automation-journal__empty');
});

it('does not manufacture quote events from legacy confirmed or reply-draft counters', () => {
  const html = renderToStaticMarkup(<AutomationJournal runs={[run]} renderRun={renderRun} organizationId="company-a" activity={{ totals: { analyzed: 80, suggestions: 3, confirmed: 75, needsReview: 2, observed: 0 }, workflows: { tasks: 10, drafts: 65, summaries: 0, open: 0, review: 2, observed: 0 } }} openQuote={vi.fn()} />);
  expect(html).not.toContain('Devis préparé'); expect(html).not.toContain('Ouvrir le devis'); expect(html).not.toContain('>Devis</button>');
});
