// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutopilotCatalogueNext, AutopilotReviews, AutopilotSettings, AutopilotStatus, type AutopilotCreatedQuoteView } from './AutopilotPanel';
import { autopilotCopy, autopilotCatalogueCopy } from './autopilotPresentation';
import type { AutopilotView } from './autopilotView';
const locale = vi.hoisted(() => ({ language: 'fr' }));
vi.mock('./language', () => ({ useAppLanguage: () => locale.language, getAppLocale: () => `${locale.language}-CH` }));
const state: AutopilotView = { status: 'ready', consent: { schemaVersion: 1, enabled: true, revision: 1,
  consentVersion: 'version', requiredConsentVersion: 'version' }, canManage: true, saving: false, error: null,
  activity: null, reviewsUnavailable: false, readingReviews: false, reviews: { organizationId: 'company-a', nextCursor: null,
    items: [{ proposalId: 'proposal-a', sourceId: 'exact-ticket-a', createdAt: 1791947827, disposition: 'needs_review',
      reasons: ['low_confidence'], requiresHumanValidation: true }] } };
const roots: { root: Root; host: HTMLDivElement }[] = [];
beforeEach(() => { locale.language = 'fr'; vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(async () => { for(const {root,host} of roots.splice(0)) { await act(async () => root.unmount()); host.remove(); } vi.unstubAllGlobals(); });
async function mount(element: ReactNode) { const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host); roots.push({root,host}); await act(async () => root.render(element)); return {root,host}; }
it.each(['fr','de','it','en'])('renders actual consent and review wording in %s', language => {
  locale.language = language; const copy = autopilotCopy(language);
  const html = renderToStaticMarkup(<><AutopilotStatus state={state} onSettings={() => {}} />
    <AutopilotSettings state={state} onConsent={async () => {}} />
    <AutopilotReviews state={state} organizationId="company-a" onOpenSource={async () => {}} /></>);
  expect(html).toContain(copy.title); expect(html).toContain(copy.consent); expect(html).toContain(copy.openRequest);
  expect(html).not.toMatch(/0\.58|low_confidence|proposal-a|exact-ticket-a|JEV|TypeSafe/);
});
it('never infers disabled consent or availability from a closed product gate', () => {
  const html = renderToStaticMarkup(<AutopilotSettings state={{ ...state,status:'unavailable',consent:null,canManage:false }} onConsent={vi.fn()} />);
  expect(html).toContain(autopilotCopy('fr').unavailable); expect(html).not.toContain('type="checkbox"');
});
it.each(['fr','de','it','en'])('explains monthly allowance independently of connection and hourly limits in %s',language=>{
  locale.language=language;const copy=autopilotCopy(language);
  const html=renderToStaticMarkup(<AutopilotStatus state={{...state,error:'quota_exhausted'}} onSettings={()=>{}}/>);
  expect(html).toContain(copy.monthlyQuota);expect(html).not.toContain(copy.connection);expect(html).not.toContain(copy.rateLimited);
});
it('does not submit consent on mount and requires a real explicit checkbox action', async () => {
  const change = vi.fn().mockResolvedValue(undefined);
  const {host} = await mount(<AutopilotSettings state={state} onConsent={change} />);
  expect(change).not.toHaveBeenCalled(); await act(async () => host.querySelector<HTMLInputElement>('input')!.click());
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
});
it('keeps collaborator and saving consent controls disabled', () => {
  for(const value of [{...state,canManage:false},{...state,saving:true}]) {
    const html=renderToStaticMarkup(<AutopilotSettings state={value} onConsent={vi.fn()} />); expect(html).toContain('disabled=""');
  }
});
it('opens only the exact Support source and removes retained reviews for another company', async () => {
  const open = vi.fn().mockResolvedValue(undefined);
  const {root,host} = await mount(<AutopilotReviews state={state} organizationId="company-a" onOpenSource={open} />);
  await act(async () => host.querySelector<HTMLButtonElement>('.quote-autopilot__requests button')!.click());
  expect(open).toHaveBeenCalledExactlyOnceWith('exact-ticket-a');
  await act(async () => root.render(<AutopilotReviews state={state} organizationId="company-b" onOpenSource={open} />));
  expect(host.querySelector('.quote-autopilot__requests')).toBeNull(); expect(host.textContent).not.toContain(autopilotCopy('fr').openRequest);
});
const missingItem = { ...state, reviews: { ...state.reviews!, items: state.reviews!.items.map(item => ({ ...item, reasons: ['missing_article'] as const })) } };
it.each(['fr','de','it','en'])('shows honest catalogue identification and manual follow-up in %s', language => {
  locale.language=language;const copy=autopilotCatalogueCopy(language);
  const html=renderToStaticMarkup(<><AutopilotReviews state={missingItem} organizationId="company-a" onOpenSource={async()=>{}} onCatalogue={()=>{}} canAddCatalogue />
    <AutopilotCatalogueNext canWrite onWriteQuote={()=>{}} onReturnRequest={async()=>{}} onDismiss={()=>{}}/></>);
  for(const text of [copy.title,copy.browse,copy.add,copy.hint,copy.savedDetail,copy.writeQuote,copy.returnRequest])expect(html).toContain(text);
  expect(html).not.toMatch(/proposal-a|exact-ticket-a|missing_article|JEV|TypeSafe/);
});
it('routes only the exact missing-item review to catalogue actions and keeps read-only creation hidden', async()=>{
  const catalogue=vi.fn();const {root,host}=await mount(<AutopilotReviews state={missingItem} organizationId="company-a" onOpenSource={async()=>{}} onCatalogue={catalogue} canAddCatalogue/>);
  const buttons=host.querySelectorAll<HTMLButtonElement>('.quote-autopilot__request-actions button');
  await act(async()=>buttons[0].click());await act(async()=>buttons[1].click());
  expect(catalogue.mock.calls).toEqual([[expect.objectContaining({proposalId:'proposal-a',sourceId:'exact-ticket-a'}),'browse'],[expect.objectContaining({proposalId:'proposal-a',sourceId:'exact-ticket-a'}),'create']]);
  await act(async()=>root.render(<AutopilotReviews state={missingItem} organizationId="company-a" onOpenSource={async()=>{}} onCatalogue={catalogue}/>));
  expect(host.textContent).toContain(autopilotCatalogueCopy('fr').browse);expect(host.textContent).not.toContain(autopilotCatalogueCopy('fr').add);
});
it('never offers catalogue actions for other reasons, another company or a closed gate',()=>{
  for(const [value,organization]of [[state,'company-a'],[missingItem,'company-b'],[{...missingItem,status:'unavailable'},'company-a']] as const){
    const html=renderToStaticMarkup(<AutopilotReviews state={value as AutopilotView} organizationId={organization} onOpenSource={async()=>{}} onCatalogue={()=>{}} canAddCatalogue/>);
    expect(html).not.toContain(autopilotCatalogueCopy('fr').browse);expect(html).not.toContain(autopilotCatalogueCopy('fr').add);
  }
});
it('requires separate explicit actions for a manual quote and the original Support message',async()=>{
  const write=vi.fn(),source=vi.fn().mockResolvedValue(undefined);const {host}=await mount(<AutopilotCatalogueNext canWrite onWriteQuote={write} onReturnRequest={source} onDismiss={()=>{}}/>);
  expect(write).not.toHaveBeenCalled();expect(source).not.toHaveBeenCalled();
  const buttons=host.querySelectorAll<HTMLButtonElement>('button');await act(async()=>buttons[0].click());expect(write).toHaveBeenCalledOnce();expect(source).not.toHaveBeenCalled();
  await act(async()=>buttons[1].click());expect(source).toHaveBeenCalledOnce();
});

it('links a request line to a catalogue article, remembers it and explains a refusal precisely', async () => {
  const copy = autopilotCopy('fr');
  const reviews = { ...state.reviews!, items: [{ ...state.reviews!.items[0], reasons: ['missing_article'],
    suggestion: { customer: null, currency: 'CHF', netCents: 0, lines: [], unmatched: ['2 licences Zentra Gestion Pro'] } }] } as AutopilotView['reviews'];
  const choose = vi.fn().mockRejectedValueOnce(new Error('forbidden')).mockResolvedValueOnce('licences zentra gestion pro');
  const { host } = await mount(<AutopilotReviews state={{ ...state, reviews }} organizationId="company-a" onOpenSource={async () => {}}
    catalogueArticles={[{ id: 'article-pro', name: 'Zentra Gestion Pro' }, { id: 'article-solo', name: 'Zentra Gestion Solo' }]} onChooseArticle={choose} />);
  expect(host.textContent).toContain(copy.unmatchedIntro);
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  const link = () => [...host.querySelectorAll('button')].find(button => button.textContent === copy.linkArticle)!;
  // Two partial matches: nothing is picked until the name is precise.
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Zentra Gestion');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(link().disabled).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Zentra Gestion Pro');
    input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => { link().click(); });
  expect(choose).toHaveBeenCalledWith('2 licences Zentra Gestion Pro', 'article-pro');
  expect(host.textContent).toContain(copy.chooseErrorRights);
  await act(async () => { link().click(); });
  expect(host.textContent).toContain(copy.linkedTo.replace('{name}', 'Zentra Gestion Pro'));
  expect(host.textContent).toContain(copy.remembered.replace('{term}', 'licences zentra gestion pro'));
  expect(host.textContent).toContain(copy.allLinked);
});

it('still shows a linked line after leaving and coming back, and offers the quote', async () => {
  const copy = autopilotCopy('fr');
  window.localStorage.setItem('zentra.autopilot.line-links.v1', JSON.stringify({ 'company-a': { 'proposal-a': {
    '2 licences Zentra Gestion Pro': { articleId: 'article-pro', name: 'Zentra Gestion Pro', term: 'gestion pro zentra' } } } }));
  const reviews = { ...state.reviews!, items: [{ ...state.reviews!.items[0], reasons: ['missing_article'],
    suggestion: { customer: null, currency: 'CHF', netCents: 0, lines: [], unmatched: ['2 licences Zentra Gestion Pro'] } }] } as AutopilotView['reviews'];
  const create = vi.fn();
  const { host } = await mount(<AutopilotReviews state={{ ...state, reviews }} organizationId="company-a" onOpenSource={async () => {}}
    catalogueArticles={[{ id: 'article-pro', name: 'Zentra Gestion Pro' }]} onChooseArticle={vi.fn()} onCreateQuote={create} />);
  expect(host.textContent).toContain(copy.linkedTo.replace('{name}', 'Zentra Gestion Pro'));
  expect(host.textContent).toContain(copy.allLinked);
  const button = [...host.querySelectorAll('button')].find(item => item.textContent === copy.createQuote)!;
  expect(button.className).toContain('is-ready');
  await act(async () => { button.click(); });
  expect(create).toHaveBeenCalledOnce();
  window.localStorage.clear();
});
it('after the quote is created, offers to send it by e-mail or open it instead of creating it again', async () => {
  const copy = autopilotCopy('fr');
  const reviews = { ...state.reviews!, items: [{ ...state.reviews!.items[0],
    suggestion: { customer: { kind: 'new', name: 'Atelier Rive' }, currency: 'CHF', netCents: 800,
      lines: [{ articleId: 'a1', description: 'Pose', unit: 'h', quantityMilli: 1000, unitPriceCents: 800, taxRateBp: 810, netCents: 800 }] } }] } as AutopilotView['reviews'];
  const send = vi.fn(), openQuote = vi.fn(), create = vi.fn();
  const { host } = await mount(<AutopilotReviews state={{ ...state, reviews }} organizationId="company-a" onOpenSource={async () => {}}
    onCreateQuote={create} createdQuote={() => ({ number: '', issued: false, clientEmail: '' })} onSendCreatedQuote={send} onOpenCreatedQuote={openQuote} />);
  expect(host.textContent).toContain(copy.quoteDraftDone);
  expect([...host.querySelectorAll('button')].some(item => item.textContent === copy.createQuote)).toBe(false);
  await act(async () => { [...host.querySelectorAll('button')].find(item => item.textContent === copy.sendQuote)!.click(); });
  await act(async () => { [...host.querySelectorAll('button')].find(item => item.textContent === copy.openQuote)!.click(); });
  expect(send).toHaveBeenCalledOnce(); expect(openQuote).toHaveBeenCalledOnce(); expect(create).not.toHaveBeenCalled();
});
it('moves a request whose quote was sent to the Terminé section', async () => {
  const copy = autopilotCopy('fr');
  const reviews = { ...state.reviews!, items: [state.reviews!.items[0], { ...state.reviews!.items[0], proposalId: 'proposal-b', sourceId: 'exact-ticket-b' }] } as AutopilotView['reviews'];
  const openQuote = vi.fn();
  const { host } = await mount(<AutopilotReviews state={{ ...state, reviews }} organizationId="company-a" onOpenSource={async () => {}} onOpenCreatedQuote={openQuote}
    createdQuote={item => item.proposalId === 'proposal-b' ? { number: 'D-2026-004', issued: true, clientEmail: 'm@r.ch', clientName: 'Atelier Rive', sentAt: Date.UTC(2026, 9, 18, 20) } : null} />);
  const done = host.querySelector('.quote-autopilot--done')!;
  expect(done.querySelectorAll('li[data-state="done"]')).toHaveLength(1);
  expect(done.textContent).toContain(copy.doneQuote.replace('{number}', 'D-2026-004'));
  expect(done.querySelector('.quote-autopilot__done-summary')!.textContent).toBe(copy.doneSentTo.replace('{client}', 'Atelier Rive'));
  expect(host.querySelector('.quote-autopilot--reviews')!.querySelectorAll('.quote-autopilot__requests > li')).toHaveLength(1);
  await act(async () => { done.querySelector('button')!.click(); });
  expect(openQuote).toHaveBeenCalledOnce();
});
it('brings an accepted quote back to follow, to create then send its invoice', async () => {
  const copy = autopilotCopy('fr');
  const create = vi.fn(), send = vi.fn();
  let view: AutopilotCreatedQuoteView = { number: 'D-2026-004', issued: true, clientEmail: 'm@r.ch', clientName: 'Atelier Rive', sentAt: 1, accepted: true };
  const render = () => <AutopilotReviews state={state} organizationId="company-a" onOpenSource={async () => {}} createdQuote={() => view}
    onCreateInvoice={create} onSendInvoice={send} onOpenInvoice={vi.fn()} />;
  const { root, host } = await mount(render());
  expect(host.querySelector('.quote-autopilot--done')).toBeNull();
  expect(host.querySelector('li[data-state="accepted"]')!.textContent).toContain(copy.acceptedTitle.replace('{number}', 'D-2026-004'));
  await act(async () => { [...host.querySelectorAll('button')].find(item => item.textContent === copy.createInvoice)!.click(); });
  expect(create).toHaveBeenCalledOnce();
  view = { ...view, invoice: { number: '', issued: false } };
  await act(async () => root.render(render()));
  await act(async () => { [...host.querySelectorAll('button')].find(item => item.textContent === copy.sendQuote)!.click(); });
  expect(send).toHaveBeenCalledOnce();
  view = { ...view, invoice: { number: 'F-2026-010', issued: true }, invoiceSentAt: 2 };
  await act(async () => root.render(render()));
  expect(host.querySelector('.quote-autopilot--done')!.textContent).toContain(copy.doneInvoice.replace('{number}', 'F-2026-010'));
});
it('asks which quote a client mail accepts when it is not found alone', async () => {
  const copy = autopilotCopy('fr');
  const choose = vi.fn();
  const { host } = await mount(<AutopilotReviews state={{ ...state, reviews: { ...state.reviews!, items: [] } }} organizationId="company-a" onOpenSource={async () => {}}
    acceptances={[{ key: 'acceptance:s1', sourceId: 's1', receivedAt: 1791947827, evidence: 'Nous acceptons votre offre.', sender: 'Atelier Rive',
      candidates: [{ id: 'q1', label: 'D-2026-0006 · Atelier Rive' }, { id: 'q2', label: 'D-2026-0007 · Paul' }] }]} onChooseAcceptance={choose} />);
  expect(host.textContent).toContain(copy.acceptanceChooseTitle.replace('{sender}', 'Atelier Rive'));
  const confirm = [...host.querySelectorAll('button')].find(item => item.textContent === copy.acceptanceConfirm)!;
  expect(confirm.disabled).toBe(true);
  const select = host.querySelector('select')!;
  await act(async () => { select.value = 'q2'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => { confirm.click(); });
  expect(choose).toHaveBeenCalledWith('s1', 'q2');
});
