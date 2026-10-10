import {beforeEach,describe,it,expect,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
const f=vi.hoisted(()=>({user:vi.fn(),requireUser:vi.fn(),enabled:vi.fn(),pilotMode:vi.fn(),sellerInstalled:vi.fn(),sellerWrite:vi.fn(),erpReadiness:vi.fn(),salesOrders:vi.fn(),bank:vi.fn(),supplier:vi.fn(),documents:vi.fn(),team:vi.fn(),sync:vi.fn(),tax:vi.fn(),supportWorkspace:vi.fn(),supportMailbox:vi.fn(),supportImport:vi.fn(),supportTriage:vi.fn(),supportTickets:vi.fn(),supportWorker:vi.fn(),spaces:vi.fn(),access:vi.fn(),preferences:vi.fn(),language:'en',pathname:'/compte/espaces',query:new URLSearchParams()}));
vi.mock('@/app/zentra-auth',()=>({getZentraUser:f.user,requireZentraUser:f.requireUser}));
vi.mock('@/lib/account-workspaces',()=>({accountWorkspaceDiscoveryEnabled:f.enabled,accountWorkspacesForUser:f.spaces,AccountWorkspaceDiscoveryError:class extends Error{}}));
vi.mock('@/lib/international/saas-authority-d1',()=>({requireUsWorkspaceAccess:f.access}));
vi.mock('@/lib/international/export-bindings',()=>({usExportReadiness:f.erpReadiness}));
vi.mock('@/lib/international/us-financial-pilot-bindings',()=>({usFinancialPilotPageMode:f.pilotMode}));
vi.mock('@/lib/international/us-financial-pilot-seller-bindings',()=>({usFinancialPilotSellerEnabled:f.sellerInstalled,usFinancialPilotSellerWriteEnabled:f.sellerWrite}));
vi.mock('@/lib/international/us-sales-order-bindings',()=>({usSalesOrderReadiness:f.salesOrders}));
vi.mock('@/lib/international/us-bank-bindings',()=>({usBankReadiness:f.bank}));
vi.mock('@/lib/international/us-supplier-bindings',()=>({usSupplierReadiness:f.supplier}));
vi.mock('@/lib/international/us-supplier-document-bindings',()=>({usSupplierDocumentsReadiness:f.documents}));
vi.mock('@/lib/international/us-team-bindings',()=>({usTeamEnabled:f.team}));
vi.mock('@/lib/international/us-workspace-sync-heads-bindings',()=>({usWorkspaceSyncEnabled:f.sync}));
vi.mock('@/lib/international/runtime-bindings',()=>({usTaxInvoiceTestEnabled:f.tax}));
vi.mock('@/lib/international/us-support-workspace-bindings',()=>({usSupportWorkspacesEnabled:f.supportWorkspace}));
vi.mock('@/lib/international/us-support-mailbox-bindings',()=>({usSupportMailboxEnabled:f.supportMailbox}));
vi.mock('@/lib/international/us-support-mailbox-import-bindings',()=>({usSupportMailImportEnabled:f.supportImport}));
vi.mock('@/lib/international/us-support-triage-bindings',()=>({usSupportTriageEnabled:f.supportTriage}));
vi.mock('@/lib/international/us-support-ticket-bindings',()=>({usSupportTicketsEnabled:f.supportTickets}));
vi.mock('@/lib/international/us-support-worker-bindings',()=>({usSupportWorkerEnabled:f.supportWorker}));
vi.mock('@/lib/account-preferences',()=>({accountPreferences:f.preferences}));
vi.mock('@/lib/site-language-server',()=>({getSiteLanguage:async()=>f.language}));
vi.mock('@/components/account/account-forms',()=>({ProfileForms:()=>createElement('div',null,'profile-fixture'),SecurityForms:()=>createElement('div',null,'security-fixture'),AppearanceForm:()=>createElement('div',null,'appearance-fixture')}));
vi.mock('@/components/account/us-financial-pilot',()=>({UsFinancialPilot:({organizationId,expectedUserId,name,role,language,sellerInstalled,sellerWriteEnabled}:{organizationId:string;expectedUserId:string;name:string;role:string;language:string;sellerInstalled:boolean;sellerWriteEnabled:boolean})=>createElement('section',{'data-workspace':organizationId,'data-expected-user':expectedUserId,'data-name':name,'data-role':role,'data-language':language,'data-seller-installed':String(sellerInstalled),'data-seller-write':String(sellerWriteEnabled)},'financial-pilot-fixture')}));
vi.mock('@/components/account/us-erp-workbench',()=>({UsErpWorkbench:({organizationId,role,language,expectedUserId,salesEnabled,invoiceIssuanceAvailable,supportedSchemaVersion,salesOrdersAvailable,newSalesOrdersEnabled,supportWorkspaceEnabled,supportMailboxEnabled,supportMailImportEnabled,supportTriageEnabled,supportTicketsEnabled,supportWorkerEnabled}:{organizationId:string;role:string;language:string;expectedUserId:string;salesEnabled:boolean;invoiceIssuanceAvailable:boolean;supportedSchemaVersion:1|2|3|4;salesOrdersAvailable:boolean;newSalesOrdersEnabled:boolean;supportWorkspaceEnabled:boolean;supportMailboxEnabled:boolean;supportMailImportEnabled:boolean;supportTriageEnabled:boolean;supportTicketsEnabled:boolean;supportWorkerEnabled:boolean})=>createElement('section',{'data-workspace':organizationId,'data-role':role,'data-language':language,'data-expected-user':expectedUserId,'data-sales':String(salesEnabled),'data-issuance':String(invoiceIssuanceAvailable),'data-schema':supportedSchemaVersion,'data-sales-orders':String(salesOrdersAvailable),'data-new-sales-orders':String(newSalesOrdersEnabled),'data-support-workspace':String(supportWorkspaceEnabled),'data-support-mailbox':String(supportMailboxEnabled),'data-support-import':String(supportMailImportEnabled),'data-support-triage':String(supportTriageEnabled),'data-support-tickets':String(supportTicketsEnabled),'data-support-worker':String(supportWorkerEnabled)},'erp-workbench-fixture')}));
vi.mock('@/components/account/us-support-workspace-panel',()=>({UsSupportWorkspacePanel:({organizationId,role,language,expectedUserId,mailboxEnabled,importEnabled,triageEnabled,ticketsEnabled,workerEnabled}:{organizationId:string;role:string;language:string;expectedUserId:string;mailboxEnabled:boolean;importEnabled:boolean;triageEnabled:boolean;ticketsEnabled:boolean;workerEnabled:boolean})=>createElement('section',{'data-workspace':organizationId,'data-role':role,'data-language':language,'data-expected-user':expectedUserId,'data-support-mailbox':String(mailboxEnabled),'data-support-import':String(importEnabled),'data-support-triage':String(triageEnabled),'data-support-tickets':String(ticketsEnabled),'data-support-worker':String(workerEnabled)},'support-workspace-fixture')}));
vi.mock('@/components/account/us-team-panel',()=>({UsTeamPanel:()=>createElement('section',null,'team-fixture')}));
vi.mock('@/components/zentra-sign-out',()=>({ZentraSignOut:()=>createElement('button',null,'Sign out')}));
vi.mock('@/components/site-language-picker',()=>({SiteLanguagePicker:()=>null}));
vi.mock('next/navigation',()=>({notFound:()=>{throw new Error('not found')},usePathname:()=>f.pathname,useSearchParams:()=>f.query}));
import WorkspacePage from '@/app/compte/espaces/page';
import UsWorkspacePage from '@/app/compte/espaces/us/[organizationId]/page';
import {WorkspacePicker} from '@/components/account/workspace-picker';
import {AccountShell} from '@/components/account/account-shell';
import {UsAuthorityError} from './international/saas-authority';
import {accountWorkspaceCopy} from './account-workspace-copy';
const id='10000000-0000-4000-8000-000000000001',owner='10000000-0000-4000-8000-000000000002';
const company='Studio North & Partners';
const user={userId:owner,displayName:'Example Owner',email:'owner@example.test'};
const us={organizationId:id,name:company,edition:'us_experimental' as const,role:'owner' as const};
const ch={organizationId:'ch-old',organizationName:'Suisse SA',role:'owner' as const};
const page=(reglage='')=>UsWorkspacePage({params:Promise.resolve({organizationId:id}),searchParams:Promise.resolve({reglage})});
const html=(node:Parameters<typeof renderToStaticMarkup>[0])=>renderToStaticMarkup(node);
beforeEach(()=>{vi.resetAllMocks();f.user.mockResolvedValue(user);f.requireUser.mockResolvedValue(user);f.enabled.mockResolvedValue(true);f.pilotMode.mockResolvedValue('legacy');f.sellerInstalled.mockResolvedValue(false);f.sellerWrite.mockResolvedValue(false);f.erpReadiness.mockResolvedValue({enabled:true,supportedSchemaVersion:2});f.salesOrders.mockResolvedValue({available:false,newOrdersEnabled:false});for(const gate of [f.bank,f.supplier,f.documents,f.team,f.sync,f.tax,f.supportWorkspace,f.supportMailbox,f.supportImport,f.supportTriage,f.supportTickets,f.supportWorker])gate.mockResolvedValue(false);f.spaces.mockResolvedValue([us]);f.access.mockResolvedValue({organizationId:id,userId:owner,role:'owner'});f.preferences.mockResolvedValue({theme:'dark',companyDraft:'',onboardingCompletedAt:null,revision:0});f.language='en';f.pathname='/compte/espaces';f.query=new URLSearchParams();});
describe('isolated authenticated workspace surfaces',()=>{
 it('renders only metadata and uses read-only account auth',async()=>{const output=html(await WorkspacePage());expect(output).toContain(company.replace('&','&amp;'));expect(output).toContain('/compte/espaces/us/'+id);expect(output).not.toMatch(/subscriptionId|authority|receipt|EIN|configuration|price_/);expect(f.requireUser).toHaveBeenCalledWith('/compte/espaces',{offerAccess:false});expect(f.user).toHaveBeenCalledWith({offerAccess:false});});
 it('never returns previous account companies after a session switch',async()=>{f.user.mockResolvedValue({...user,userId:'other'});expect(html(await WorkspacePage())).not.toContain(company);});
 it('keeps the US entry closed when flags are off without a registry or rights query',async()=>{f.enabled.mockResolvedValue(false);expect(html(await page())).toContain(accountWorkspaceCopy.en.denied);expect(f.spaces).not.toHaveBeenCalled();expect(f.access).not.toHaveBeenCalled();});
 it('filters US cards when flags turn off during the final Auth check',async()=>{f.user.mockImplementation(async()=>{f.enabled.mockResolvedValue(false);return user;});const output=html(await WorkspacePage());expect(output).not.toContain(company);});
 it('keeps the US page closed when flags turn off during its last Auth check',async()=>{f.user.mockImplementation(async()=>{f.enabled.mockResolvedValue(false);return user;});expect(html(await page())).not.toContain(company);});
 it('does not render old appearance preferences when the account changes during their read',async()=>{f.preferences.mockImplementation(async()=>{f.user.mockResolvedValue({...user,userId:'another-account'});return {theme:'dark',companyDraft:'private-company',revision:0};});const output=html(await page('apparence'));expect(output).not.toContain('appearance-fixture');expect(output).toContain(accountWorkspaceCopy.en.denied);});
 it('does not treat a Swiss card as a US admission',async()=>{f.spaces.mockResolvedValue([{...us,edition:'ch_legacy'}]);expect(html(await page())).toContain(accountWorkspaceCopy.en.denied);expect(f.access).not.toHaveBeenCalled();});
 it.each([new UsAuthorityError('subscription_required',402),new UsAuthorityError('forbidden',403),new UsAuthorityError('service_unavailable',503)])('does not expose company identity or proof after denied fresh rights %s',async error=>{f.access.mockRejectedValue(error);const output=html(await page());expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain(company);expect(output).not.toContain('402');});
 it('uses read-only auth, current rights and only safe US destinations',async()=>{const output=html(await page());expect(output).toContain(company.replace('&','&amp;'));expect(output).toContain(accountWorkspaceCopy.en.preparation);expect(output).not.toMatch(/href=.[^"]*(?:compte\/(?:abonnement|equipe|automation|sauvegardes)|download)/);expect(f.access).toHaveBeenCalledWith(id,owner);expect(f.requireUser).toHaveBeenCalledWith('/compte/espaces/us/'+id,{offerAccess:false});});
 it.each([null,{...user,userId:'different'}])('denies a changed or revoked browser session after US reads',async current=>{f.user.mockResolvedValue(current);expect(html(await page())).not.toContain(company);});
 it('rejects a role changed during discovery and authorization',async()=>{f.access.mockResolvedValue({organizationId:id,userId:owner,role:'member'});expect(html(await page())).toContain(accountWorkspaceCopy.en.denied);});
 it.each(['profil','securite','apparence'])('keeps personal %s forms inside the checked US destination',async setting=>{const output=html(await page(setting));expect(output).toContain('-fixture');expect(output).toContain('?reglage='+setting);expect(output).not.toContain('/compte/equipe');});
 it.each(['owner','admin','accountant','member','read_only'])('passes only the fresh scoped %s role to the US workbench',async role=>{f.spaces.mockResolvedValue([{...us,role}]);f.access.mockResolvedValue({organizationId:id,userId:owner,role});const output=html(await page('gestion'));expect(output).toContain('erp-workbench-fixture');expect(output).toContain('data-workspace="'+id+'"');expect(output).toContain('data-role="'+role+'"');expect(output).toContain('data-language="en"');expect(output).not.toMatch(/subscriptionId|price_|ch-old/);});
 it('exposes only server-negotiated read capability and keeps real invoice issuance closed',async()=>{const output=html(await page('gestion'));expect(output).toContain('data-sales="true"');expect(output).toContain('data-schema="2"');expect(output).toContain('data-issuance="false"');});
 it('does not open sales or schema two when the trusted ERP binding is unavailable',async()=>{f.erpReadiness.mockResolvedValue({enabled:false,supportedSchemaVersion:1});const output=html(await page('gestion'));expect(output).toContain('data-sales="false"');expect(output).toContain('data-schema="1"');expect(output).toContain('data-issuance="false"');});
 it('checks the account again after waiting for export readiness',async()=>{f.erpReadiness.mockImplementation(async()=>{f.user.mockResolvedValue({...user,userId:'changed-during-readiness'});return {enabled:true,supportedSchemaVersion:2};});expect(html(await page('gestion'))).not.toContain('erp-workbench-fixture');});
 describe('financial pilot page admission before frozen ERP4 readiness',()=>{
  const oldReadiness=()=>[f.erpReadiness,f.salesOrders,f.bank,f.supplier,f.documents,f.team,f.sync,f.tax,f.supportWorkspace,f.supportMailbox,f.supportImport,f.supportTriage,f.supportTickets,f.supportWorker];
  it.each([false,true].flatMap(installed=>[false,true].map(write=>({installed,write}))))('normalizes seller presentation installed=$installed write=$write without granting API rights',async({installed,write})=>{
   f.pilotMode.mockResolvedValue('pilot');f.sellerInstalled.mockResolvedValue(installed);f.sellerWrite.mockResolvedValue(write);
   const output=html(await page('gestion'));
   expect(output).toContain('financial-pilot-fixture');expect(output).toContain('data-seller-installed="'+String(installed)+'"');expect(output).toContain('data-seller-write="'+String(installed&&write)+'"');
   expect(f.sellerInstalled).toHaveBeenCalledTimes(1);expect(f.sellerWrite).toHaveBeenCalledTimes(installed?1:0);for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it.each(['installed','write'].flatMap(gate=>['switched','signed_out','revoked','role','discovery'].map(change=>({gate,change}))))('withholds previous workspace when $change occurs while awaiting seller $gate',async({gate,change})=>{
   f.pilotMode.mockResolvedValue('pilot');f.sellerInstalled.mockResolvedValue(true);f.sellerWrite.mockResolvedValue(true);
   const waiting=gate==='installed'?f.sellerInstalled:f.sellerWrite;
   waiting.mockImplementation(async()=>{
    if(change==='switched')f.user.mockResolvedValue({...user,userId:'changed-during-seller-flags'});
    if(change==='signed_out')f.user.mockResolvedValue(null);
    if(change==='revoked')f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));
    if(change==='role')f.access.mockResolvedValue({organizationId:id,userId:owner,role:'member'});
    if(change==='discovery')f.enabled.mockResolvedValue(false);
    return true;
   });
   const output=html(await page('gestion'));
   expect(waiting).toHaveBeenCalledTimes(1);expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('financial-pilot-fixture');expect(output).not.toContain('erp-workbench-fixture');expect(output).not.toContain(company.replace('&','&amp;'));expect(output).not.toContain('data-workspace="'+id+'"');for(const readiness of oldReadiness())expect(readiness).not.toHaveBeenCalled();
  });
  it.each(['legacy','unavailable'])('does not consult seller capabilities for %s mode',async mode=>{
   f.pilotMode.mockResolvedValue(mode);await page('gestion');expect(f.sellerInstalled).not.toHaveBeenCalled();expect(f.sellerWrite).not.toHaveBeenCalled();
  });
  it.each(['owner','admin','accountant'])('mounts the admitted %s pilot with only scoped public props and no ERP4/sidecar readiness',async role=>{
   f.pilotMode.mockResolvedValue('pilot');f.spaces.mockResolvedValue([{...us,role}]);f.access.mockResolvedValue({organizationId:id,userId:owner,role});
   const output=html(await page('gestion'));expect(output).toContain('financial-pilot-fixture');expect(output).toContain('data-workspace="'+id+'"');expect(output).toContain('data-expected-user="'+owner+'"');expect(output).toContain('data-name="Studio North &amp; Partners"');expect(output).toContain('data-role="'+role+'"');expect(output).toContain('data-language="en"');
   expect(output).not.toContain('erp-workbench-fixture');expect(output).not.toMatch(/grantVersion|optInVersion|ledger|receipt|policy|subscriptionId|price_/);expect(f.pilotMode).toHaveBeenCalledWith(id,owner);for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it('shows only unavailable for a promoted but closed workspace without consulting legacy readiness',async()=>{
   f.pilotMode.mockResolvedValue('unavailable');const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('financial-pilot-fixture');expect(output).not.toContain('erp-workbench-fixture');expect(output).not.toContain(company);for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it.each(['member','read_only'])('keeps nonpromoted %s on ERP4',async role=>{
   f.spaces.mockResolvedValue([{...us,role}]);f.access.mockResolvedValue({organizationId:id,userId:owner,role});const output=html(await page('gestion'));expect(output).toContain('erp-workbench-fixture');expect(output).not.toContain('financial-pilot-fixture');expect(f.pilotMode).toHaveBeenCalledTimes(1);expect(f.erpReadiness).toHaveBeenCalledTimes(1);
  });
  it.each(['member','read_only'])('refuses a stale or inconsistent pilot decision for %s',async role=>{
   f.pilotMode.mockResolvedValue('pilot');f.spaces.mockResolvedValue([{...us,role}]);f.access.mockResolvedValue({organizationId:id,userId:owner,role});const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('financial-pilot-fixture');expect(output).not.toContain('erp-workbench-fixture');for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it.each([null,{...user,userId:'changed-after-pilot'}])('withholds a pilot when the account changes while selecting it',async current=>{
   f.pilotMode.mockImplementation(async()=>{f.user.mockResolvedValue(current);return 'pilot';});const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('financial-pilot-fixture');for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it.each(['membership','role','discovery'])('withholds a pilot if %s changes after selection',async changed=>{
   f.pilotMode.mockImplementation(async()=>{if(changed==='membership')f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));if(changed==='role')f.access.mockResolvedValue({organizationId:id,userId:owner,role:'accountant'});if(changed==='discovery')f.enabled.mockResolvedValue(false);return 'pilot';});
   const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('financial-pilot-fixture');for(const gate of oldReadiness())expect(gate).not.toHaveBeenCalled();
  });
  it.each(['','support','equipe','profil','securite','apparence'])('does not select or expose the financial pilot on %s',async setting=>{
   f.team.mockResolvedValue(true);f.supportWorkspace.mockResolvedValue(true);f.pilotMode.mockResolvedValue('pilot');const output=html(await page(setting));expect(f.pilotMode).not.toHaveBeenCalled();expect(f.sellerInstalled).not.toHaveBeenCalled();expect(f.sellerWrite).not.toHaveBeenCalled();expect(output).not.toContain('financial-pilot-fixture');
  });
  it('keeps the Swiss workspace picker independent of the US pilot',async()=>{
   f.spaces.mockResolvedValue([{organizationId:'ch-old',name:'Suisse SA',edition:'ch_legacy',role:'owner'}]);const output=html(await WorkspacePage());expect(output).toContain('Suisse SA');expect(output).toContain('/compte/entreprise?organizationId=ch-old');expect(f.pilotMode).not.toHaveBeenCalled();
  });
 });
 describe('sales-order page admission',()=>{
  it.each([
   {available:false,newOrdersEnabled:false},
   {available:true,newOrdersEnabled:false},
   {available:true,newOrdersEnabled:true},
  ])('passes distinct schema4 history $available and new-order $newOrdersEnabled flags',async readiness=>{
   f.erpReadiness.mockResolvedValue({enabled:true,supportedSchemaVersion:4});f.salesOrders.mockResolvedValue(readiness);
   const output=html(await page('gestion'));
   expect(output).toContain('erp-workbench-fixture');expect(output).toContain('data-schema="4"');
   expect(output).toContain('data-sales-orders="'+String(readiness.available)+'"');expect(output).toContain('data-new-sales-orders="'+String(readiness.newOrdersEnabled)+'"');
   expect(output).toContain('data-expected-user="'+owner+'"');expect(output).toContain('data-issuance="false"');
   expect(f.salesOrders).toHaveBeenCalledTimes(1);expect(f.access).toHaveBeenLastCalledWith(id,owner);expect(f.user).toHaveBeenCalledWith({offerAccess:false});
  });
  it.each([1,2,3] as const)('does not advertise orders to schema %s even if their separate binding was momentarily open',async supportedSchemaVersion=>{
   f.erpReadiness.mockResolvedValue({enabled:true,supportedSchemaVersion});f.salesOrders.mockResolvedValue({available:true,newOrdersEnabled:true});
   const output=html(await page('gestion'));expect(output).toContain('erp-workbench-fixture');expect(output).toContain('data-schema="'+String(supportedSchemaVersion)+'"');expect(output).toContain('data-sales-orders="false"');expect(output).toContain('data-new-sales-orders="false"');
  });
  it('keeps orders closed when the ERP read admission is unavailable even with a schema4-shaped readiness result',async()=>{
   f.erpReadiness.mockResolvedValue({enabled:false,supportedSchemaVersion:4});f.salesOrders.mockResolvedValue({available:true,newOrdersEnabled:true});
   const output=html(await page('gestion'));expect(output).toContain('data-sales="false"');expect(output).toContain('data-sales-orders="false"');expect(output).toContain('data-new-sales-orders="false"');
  });
  it.each([null,{...user,userId:'changed-during-order-readiness'}])('does not mount a previous account workbench after identity changes during order readiness',async current=>{
   f.erpReadiness.mockResolvedValue({enabled:true,supportedSchemaVersion:4});f.salesOrders.mockImplementation(async()=>{f.user.mockResolvedValue(current);return{available:true,newOrdersEnabled:true};});
   const output=html(await page('gestion'));expect(f.salesOrders).toHaveBeenCalledTimes(1);expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('erp-workbench-fixture');expect(output).not.toContain('data-sales-orders');
  });
  it('denies a role changed during order readiness instead of passing stale commercial access',async()=>{
   f.salesOrders.mockImplementation(async()=>{f.access.mockResolvedValue({organizationId:id,userId:owner,role:'member'});return{available:true,newOrdersEnabled:true};});
   const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('erp-workbench-fixture');expect(f.access).toHaveBeenLastCalledWith(id,owner);
  });
  it('denies revoked rights after the order readiness wait',async()=>{
   f.salesOrders.mockImplementation(async()=>{f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));return{available:true,newOrdersEnabled:true};});
   const output=html(await page('gestion'));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('erp-workbench-fixture');expect(f.access).toHaveBeenLastCalledWith(id,owner);
  });
  it.each(['','support','equipe','profil','securite','apparence'])('does not consult or expose orders on the %s destination',async setting=>{
   f.team.mockResolvedValue(true);f.supportWorkspace.mockResolvedValue(true);f.salesOrders.mockResolvedValue({available:true,newOrdersEnabled:true});
   const output=html(await page(setting));expect(f.salesOrders).not.toHaveBeenCalled();expect(output).not.toContain('data-sales-orders');expect(output).not.toContain('data-new-sales-orders');expect(output).not.toContain('erp-workbench-fixture');
  });
  it('does not query or expose the order feature in the account workspace picker',async()=>{
   f.salesOrders.mockResolvedValue({available:true,newOrdersEnabled:true});const output=html(await WorkspacePage());expect(f.salesOrders).not.toHaveBeenCalled();expect(output).not.toContain('data-sales-orders');expect(output).not.toContain('data-new-sales-orders');
  });
 });
 describe('Support worker page admission',()=>{
  const open=()=>{for(const gate of [f.supportWorkspace,f.supportMailbox,f.supportTriage,f.supportTickets,f.supportWorker])gate.mockResolvedValue(true);};
  it.each(['support','gestion'])('passes the separately gated intake capability to %s',async setting=>{
   open();const output=html(await page(setting));expect(output).toContain('data-support-worker="true"');expect(f.supportWorker).toHaveBeenCalledTimes(1);expect(f.access).toHaveBeenLastCalledWith(id,owner);
  });
  it.each(['support','gestion'].flatMap(setting=>['triage','tickets','worker'].map(closed=>({setting,closed}))))('keeps intake closed on $setting when $closed is closed',async({setting,closed})=>{
   open();({triage:f.supportTriage,tickets:f.supportTickets,worker:f.supportWorker}[closed]!).mockResolvedValue(false);
   const output=html(await page(setting));expect(output).toContain('data-support-worker="false"');if(closed!=='worker')expect(f.supportWorker).not.toHaveBeenCalled();
  });
  it.each(['support','gestion'])('purges the %s surface when identity changes during intake readiness',async setting=>{
   open();f.supportWorker.mockImplementation(async()=>{f.user.mockResolvedValue({...user,userId:'changed-after-worker-read'});return true;});
   const output=html(await page(setting));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('-fixture');
  });
  it.each(['support','gestion'])('checks current rights again after intake readiness on %s',async setting=>{
   open();f.supportWorker.mockImplementation(async()=>{f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));return true;});
   const output=html(await page(setting));expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('-fixture');expect(f.access).toHaveBeenLastCalledWith(id,owner);
  });
 });
 describe('Support ticket page admission',()=>{
  it.each(['support','gestion'].flatMap(setting=>['owner','admin','accountant','member','read_only'].map(role=>({setting,role}))))('passes ticket history to $setting for an admitted $role while mailbox, import and triage are closed',async({setting,role})=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockResolvedValue(true);
   f.spaces.mockResolvedValue([{...us,role}]);f.access.mockResolvedValue({organizationId:id,userId:owner,role});
   const output=html(await page(setting));
   expect(output).toContain(setting==='support'?'support-workspace-fixture':'erp-workbench-fixture');
   expect(output).toContain('data-support-tickets="true"');expect(output).toContain('data-workspace="'+id+'"');expect(output).toContain('data-role="'+role+'"');expect(output).toContain('data-expected-user="'+owner+'"');
   for(const feature of ['mailbox','import','triage'])expect(output).toContain('data-support-'+feature+'="false"');
   if(setting==='gestion')expect(output).toContain('data-support-workspace="true"');
   expect(f.access).toHaveBeenCalledWith(id,owner,'support');expect(f.access).toHaveBeenLastCalledWith(id,owner);
   expect(f.supportTickets).toHaveBeenCalledTimes(1);expect(f.supportMailbox).toHaveBeenCalledTimes(1);expect(f.supportImport).not.toHaveBeenCalled();expect(f.supportTriage).not.toHaveBeenCalled();
  });
  it('passes independently admitted ticket history even when the workbench sales read is unavailable',async()=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockResolvedValue(true);f.erpReadiness.mockResolvedValue({enabled:false,supportedSchemaVersion:1});
   const output=html(await page('gestion'));expect(output).toContain('erp-workbench-fixture');expect(output).toContain('data-sales="false"');expect(output).toContain('data-schema="1"');expect(output).toContain('data-support-tickets="true"');
  });
  it.each(['support','gestion'])('passes the closed ticket flag to %s even when all mailbox features are open',async setting=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportMailbox.mockResolvedValue(true);f.documents.mockResolvedValue(true);f.supportImport.mockResolvedValue(true);f.supportTriage.mockResolvedValue(true);
   const output=html(await page(setting));expect(output).toContain(setting==='support'?'support-workspace-fixture':'erp-workbench-fixture');expect(output).toContain('data-support-tickets="false"');
   for(const feature of ['mailbox','import','triage'])expect(output).toContain('data-support-'+feature+'="true"');
   expect(f.supportTickets).toHaveBeenCalledTimes(1);
  });
  it.each(['support','gestion'])('does not consult or pass ticket admission to %s when H1 is disabled',async setting=>{
   f.supportTickets.mockResolvedValue(true);f.supportMailbox.mockResolvedValue(true);
   const output=html(await page(setting));expect(output).not.toContain('support-workspace-fixture');expect(output).not.toContain('data-support-tickets="true"');expect(output).not.toContain('?reglage=support');
   if(setting==='support')expect(output).toContain(accountWorkspaceCopy.en.denied);else{expect(output).toContain('erp-workbench-fixture');expect(output).toContain('data-support-workspace="false"');expect(output).toContain('data-support-tickets="false"');}
   expect(f.supportTickets).not.toHaveBeenCalled();expect(f.supportMailbox).not.toHaveBeenCalled();
  });
  it.each(['support','gestion'].flatMap(setting=>[402,403].map(status=>({setting,status}))))('keeps ticket history closed on $setting after H1 admission rejects $status',async({setting,status})=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockResolvedValue(true);
   f.access.mockImplementation(async(_organizationId,_userId,module)=>{if(module==='support')throw new UsAuthorityError(status===402?'subscription_required':'forbidden',status);return{organizationId:id,userId:owner,role:'owner'};});
   const output=html(await page(setting));expect(output).not.toContain('support-workspace-fixture');expect(output).not.toContain('data-support-tickets="true"');expect(output).not.toContain('?reglage=support');
   if(setting==='support')expect(output).toContain(accountWorkspaceCopy.en.denied);else expect(output).toContain('data-support-workspace="false"');
   expect(f.supportTickets).not.toHaveBeenCalled();expect(f.supportMailbox).not.toHaveBeenCalled();
  });
  it.each(['support','gestion'])('rejects ticket admission to %s when the Support role differs from discovery',async setting=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockResolvedValue(true);
   f.access.mockImplementation(async(_organizationId,_userId,module)=>({organizationId:id,userId:owner,role:module==='support'?'member':'owner'}));
   const output=html(await page(setting));expect(output).not.toContain('support-workspace-fixture');expect(output).not.toContain('data-support-tickets="true"');expect(f.supportTickets).not.toHaveBeenCalled();
  });
  it.each(['support','gestion'].flatMap(setting=>[null,{...user,userId:'changed-after-ticket-readiness'}].map(current=>({setting,current}))))('does not mount ticket history on $setting after the session changes during its gated read',async({setting,current})=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockImplementation(async()=>{f.user.mockResolvedValue(current);return true;});
   const output=html(await page(setting));expect(f.supportTickets).toHaveBeenCalledTimes(1);expect(f.user).toHaveBeenCalledWith({offerAccess:false});expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('support-workspace-fixture');expect(output).not.toContain('erp-workbench-fixture');expect(output).not.toContain('data-support-tickets');
  });
  it.each(['support','gestion'])('checks fresh rights again after the %s ticket flag read',async setting=>{
   f.supportWorkspace.mockResolvedValue(true);f.supportTickets.mockImplementation(async()=>{f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));return true;});
   const output=html(await page(setting));expect(f.supportTickets).toHaveBeenCalledTimes(1);expect(f.access).toHaveBeenLastCalledWith(id,owner);expect(output).toContain(accountWorkspaceCopy.en.denied);expect(output).not.toContain('support-workspace-fixture');expect(output).not.toContain('erp-workbench-fixture');
  });
 });
 it.each(['disabled','revoked','switched','changed_role','wrong_edition'])('does not mount the workbench for %s access',async reason=>{if(reason==='disabled')f.enabled.mockResolvedValue(false);if(reason==='revoked')f.access.mockRejectedValue(new UsAuthorityError('forbidden',403));if(reason==='switched')f.user.mockResolvedValue({...user,userId:'another'});if(reason==='changed_role')f.access.mockResolvedValue({organizationId:id,userId:owner,role:'member'});if(reason==='wrong_edition')f.spaces.mockResolvedValue([{...us,edition:'ch_legacy'}]);expect(html(await page('gestion'))).not.toContain('erp-workbench-fixture');});
 it('links the US workspace overview to its own workbench without a Swiss subscription query',async()=>{const output=html(await page());expect(output).toContain('/compte/espaces/us/'+id+'?reglage=gestion');expect(output).not.toContain('organizationId=ch');});
 it.each(['en','fr','de','it'] as const)('renders workspace copy in %s without translating a company name',async language=>{f.language=language;const output=html(await WorkspacePage());expect(output).toContain(accountWorkspaceCopy[language].title);expect(output).toContain(company.replace('&','&amp;'));});
 it('removes Swiss subscription/device destinations from the US shell',()=>{f.pathname='/compte/espaces/us/'+id;const output=html(createElement(AccountShell,{displayName:'Owner',email:'owner@example.test',organizations:[ch],theme:'dark',language:'en'},createElement('p',null,'US content')));expect(output).toContain('/compte/espaces');expect(output).not.toMatch(/\/compte\/(?:equipe|abonnement|connexions|automation|donnees)|\/download|ch-old/);});
 it('keeps all existing Swiss sections and company queries',()=>{f.pathname='/compte/equipe';f.query=new URLSearchParams({organizationId:'ch-old'});const output=html(createElement(AccountShell,{displayName:'Owner',email:'owner@example.test',organizations:[ch],theme:'light'},createElement('p',null,'Swiss content')));expect(output).toContain('/compte/equipe?organizationId=ch-old');expect(output).toContain('/compte/abonnement?organizationId=ch-old');expect(output).toContain('/download');});
 it('emits safe local layout fixtures using the actual shell and picker',()=>{
  f.pathname='/compte/espaces';const directory='.qa/account-workspace-discovery/preview';mkdirSync(directory,{recursive:true});const css=readFileSync('app/compte/account.css','utf8')+'\n'+readFileSync('app/apple-account.css','utf8');
  for(const language of ['fr','en','de','it'] as const)for(const theme of ['light','dark'] as const){const content=createElement(WorkspacePicker,{workspaces:[{...us,name:'An exceptionally long company name — Société de services & partenaires internationaux'},{organizationId:'ch-old',name:'Suisse SA',edition:'ch_legacy',role:'read_only'}],language});const markup=html(createElement(AccountShell,{displayName:'Example Owner',email:'owner@example.test',organizations:[ch],theme,language},content));writeFileSync(`${directory}/${language}-${theme}.html`,`<!doctype html><html lang="${language}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local workspace fixture</title><style>:root{--font-geist-sans:Arial,sans-serif}body{margin:0}a{text-decoration:none}button{font:inherit}${css}</style><body>${markup}</body></html>`);}
 });
});
