// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AutopilotCatalogueNext, AutopilotReviews, AutopilotSettings, AutopilotStatus } from './AutopilotPanel';
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
