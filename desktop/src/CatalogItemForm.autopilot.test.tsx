// @vitest-environment jsdom
import { act, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const api=vi.hoisted(()=>({saveCatalogItem:vi.fn()}));
const locale=vi.hoisted(()=>({language:'fr'}));
vi.mock('./bridge',()=>({desktopApi:api}));
vi.mock('./language',async()=>{const {catalogFormTranslations}=await import('./translationsCatalogForm');return {
  useAppLanguage:()=>locale.language,getAppLanguage:()=>locale.language,t:(source:string,values?:Record<string,string|number>)=>{
    const index=['de','it','en'].indexOf(locale.language),translated=index<0?source:catalogFormTranslations[source]?.[index]??source;
    return translated.replace(/\{([^}]+)\}/g,(_,key:string)=>String(values?.[key]??`{${key}}`));
  }};});
vi.mock('./ErrorGuidance',()=>({ErrorGuidance:()=>null}));
vi.mock('./ui',()=>({
  Modal:({children,title,description}:{children:ReactNode;title:string;description:string})=><section><h1>{title}</h1><p>{description}</p>{children}</section>,
  Button:({children,variant:_variant,size:_size,...props}:ButtonHTMLAttributes<HTMLButtonElement>&{variant?:string;size?:string})=><button {...props}>{children}</button>,
  Field:({children,label,error}:{children:ReactNode;label:string;error?:string})=><label>{label}{children}{error&&<span role="alert">{error}</span>}</label>,
  FormActions:({disabled,busy,submitLabel}:{disabled:boolean;busy:boolean;submitLabel:string})=><button type="submit" disabled={disabled||busy}>{submitLabel}</button>,
}));
import { CatalogItemForm } from './CatalogItemForm';
import { FormDraftIdentityProvider } from './useFormDraft';
import { initialOnboardingSettings } from './onboardingDraft';
import type { CatalogItem, Workspace } from './types';
import type { AutopilotCatalogueRequest } from './autopilotCatalogue';
import { catalogFormTranslations } from './translationsCatalogForm';
const origin={workspaceScope:'workspace-a',memberContextNonce:'a'.repeat(32)};
const request:AutopilotCatalogueRequest={organizationId:'company-a',proposalId:'proposal-a',sourceId:'source-a',origin};
const identity={companyId:'workspace-a',organizationId:'company-a',memberId:'member-a',memberContextNonce:origin.memberContextNonce,ready:true};
const settings=structuredClone(initialOnboardingSettings);settings.organization.vatRegistered=true;settings.billing.vatRatesBp=[810,0];
let root:Root|null=null,host:HTMLDivElement;
const originalScroll=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView');
beforeEach(()=>{vi.clearAllMocks();locale.language='fr';localStorage.clear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{value:vi.fn(),configurable:true});api.saveCatalogItem.mockResolvedValue({});});
afterEach(async()=>{if(root)await act(async()=>root!.unmount());root=null;host?.remove();vi.restoreAllMocks();vi.unstubAllGlobals();
  if(originalScroll)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',originalScroll);else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');});
async function mount(actual=origin,items:CatalogItem[]=[],withReview=true){
  const created=vi.fn(),workspace={workNotesScope:'workspace-a',settings,catalogItems:items,stockMovements:[]} as unknown as Workspace;
  const run=vi.fn(async(action:(value:typeof origin)=>Promise<Workspace>)=>{await action(actual);return true;});
  host=document.createElement('div');document.body.append(host);root=createRoot(host);
  await act(async()=>root!.render(<FormDraftIdentityProvider {...identity}><CatalogItemForm workspace={workspace} busy={false} readOnly={false} close={()=>{}} act={run} onReadWorkspace={async()=>workspace} autopilotRequest={withReview?request:undefined} onCreated={created}/></FormDraftIdentityProvider>));
  return {created,run};
}
async function fill(name:string,value:string){const input=host.querySelector<HTMLInputElement|HTMLSelectElement>(`[name="${name}"]`)!;
  const prototype=input instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype;
  await act(async()=>{Object.getOwnPropertyDescriptor(prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event(input instanceof HTMLSelectElement?'change':'input',{bubbles:true}));});}
async function submit(){await act(async()=>host.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));}
it('opens the real editor blank and requires an explicit human VAT choice before saving',async()=>{
  const {created}=await mount();expect(host.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('');
  expect(host.querySelector<HTMLInputElement>('[name="salesPrice"]')!.value).toBe('');expect(host.querySelector<HTMLSelectElement>('[name="vatBp"]')!.value).toBe('');
  expect(api.saveCatalogItem).not.toHaveBeenCalled();await fill('name','Intervention');await fill('unit','heure');await fill('salesPrice','85,50');await submit();
  expect(api.saveCatalogItem).not.toHaveBeenCalled();expect(created).not.toHaveBeenCalled();
  await fill('vatBp','810');await submit();expect(api.saveCatalogItem).toHaveBeenCalledOnce();
  const [id,data,,scope,nonce]=api.saveCatalogItem.mock.calls[0];expect(data).toMatchObject({name:'Intervention',salesPriceCents:8550,vatBp:810});
  expect(scope).toBe('workspace-a');expect(nonce).toBe(origin.memberContextNonce);expect(created).toHaveBeenCalledExactlyOnceWith(id);
});
it('never invokes the catalogue writer or a completion callback after the member context changes',async()=>{
  const {created}=await mount({...origin,memberContextNonce:'b'.repeat(32)});await fill('name','Article humain');await fill('unit','pièce');await fill('salesPrice','19.90');await fill('vatBp','0');await submit();
  expect(api.saveCatalogItem).not.toHaveBeenCalled();expect(created).not.toHaveBeenCalled();
});
it('keeps an existing archived SKU in the catalogue and refuses a duplicate creation from this review',async()=>{
  const item={id:'existing',sku:'OLD-100',archivedAt:'2026-01-01'} as CatalogItem;const {created}=await mount(origin,[item]);
  await fill('name','Article humain');await fill('unit','pièce');await fill('salesPrice','19.90');await fill('vatBp','0');await fill('sku',' old-100 ');await submit();
  expect(api.saveCatalogItem).not.toHaveBeenCalled();expect(created).not.toHaveBeenCalled();expect(host.textContent).toContain('Cette référence existe déjà');expect(item.archivedAt).toBe('2026-01-01');
});
it('stores the translated English unit only when the user explicitly selects its preset in the ordinary editor',async()=>{
  locale.language='en';await mount(origin,[],false);await fill('name','Human-entered service');await fill('unit','Custom unit');await fill('salesPrice','85.50');await fill('vatBp','0');
  expect(host.querySelector<HTMLInputElement>('[name="unit"]')!.value).toBe('Custom unit');
  const hour=Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='hour')!;
  await act(async()=>hour.click());expect(host.querySelector<HTMLInputElement>('[name="unit"]')!.value).toBe('hour');expect(hour.getAttribute('aria-pressed')).toBe('true');
  await submit();expect(api.saveCatalogItem).toHaveBeenCalledOnce();expect(api.saveCatalogItem.mock.calls[0][1]).toMatchObject({name:'Human-entered service',unit:'hour'});
});
it.each(['fr','de','it','en'])('translates the complete real creation editor and actionable input errors in %s',async language=>{
  locale.language=language;await mount();const index=['de','it','en'].indexOf(language),text=(key:string)=>index<0?key:catalogFormTranslations[key][index];
  for(const key of ['Que proposez-vous ?','Nom à retrouver dans les documents','Unité du prix','Prix de vente par unité (CHF, hors TVA)',
    'Quel montant pour le client ?','TVA à ajouter','Référence interne','Description pour les devis et factures','Coût d’achat par unité (CHF)',
    'Référence, description et coût d’achat','Facultatif','Ajouter au catalogue'])expect(host.textContent).toContain(text(key));
  expect(host.querySelector<HTMLInputElement>('[name="name"]')!.placeholder).toBe(text('Ex. Pose de parquet'));
  await fill('name','Nom saisi par le client');await fill('unit','Unité du client');await fill('vatBp','0');await submit();
  expect(host.textContent).toContain(text('Indiquez le prix pour une unité, à partir de zéro, avec deux décimales maximum. Exemple : 85,50.'));
  expect(host.querySelector<HTMLInputElement>('[name="name"]')!.value).toBe('Nom saisi par le client');expect(api.saveCatalogItem).not.toHaveBeenCalled();
});
