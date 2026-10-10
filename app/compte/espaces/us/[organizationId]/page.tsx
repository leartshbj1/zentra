import { notFound } from 'next/navigation';
import { UsErpWorkbench } from '@/components/account/us-erp-workbench';
import { getZentraUser, requireZentraUser } from '@/app/zentra-auth';
import { accountWorkspaceDiscoveryEnabled, accountWorkspacesForUser, AccountWorkspaceDiscoveryError, type AccountWorkspace } from '@/lib/account-workspaces';
import { requireUsWorkspaceAccess } from '@/lib/international/saas-authority-d1';
import { UsAuthorityError } from '@/lib/international/saas-authority';
import { getSiteLanguage } from '@/lib/site-language-server';
import { accountWorkspaceCopy, accountWorkspaceRole } from '@/lib/account-workspace-copy';
import { ProfileForms, SecurityForms, AppearanceForm } from '@/components/account/account-forms';
import { accountUsNavigation } from '@/lib/account-workspace-navigation';
import { accountPreferences, type AccountPreferences } from '@/lib/account-preferences';
import { usExportReadiness } from '@/lib/international/export-bindings';
import { usBankReadiness } from '@/lib/international/us-bank-bindings';
import { usSupplierReadiness } from '@/lib/international/us-supplier-bindings';
import { usSupplierDocumentsReadiness } from '@/lib/international/us-supplier-document-bindings';
import { usTeamEnabled } from '@/lib/international/us-team-bindings';
import { usWorkspaceSyncEnabled } from '@/lib/international/us-workspace-sync-heads-bindings';
import { UsTeamPanel } from '@/components/account/us-team-panel';
import { browserUsTeamCopy } from '@/lib/international/browser-us-team-copy';
import { usTaxInvoiceTestEnabled } from '@/lib/international/runtime-bindings';
import { usSupportWorkspacesEnabled } from '@/lib/international/us-support-workspace-bindings';
import { UsSupportWorkspacePanel } from '@/components/account/us-support-workspace-panel';
import { usSupportMailboxEnabled } from "@/lib/international/us-support-mailbox-bindings";
import { usSupportMailImportEnabled } from "@/lib/international/us-support-mailbox-import-bindings";
import { usSupportTriageEnabled } from '@/lib/international/us-support-triage-bindings';
import { usSupportWorkerEnabled } from '@/lib/international/us-support-worker-bindings';
import { usSupportTicketsEnabled } from '@/lib/international/us-support-ticket-bindings';
export const dynamic='force-dynamic';
export const metadata={robots:{index:false,follow:false}};
export default async function UsWorkspacePage({params,searchParams}:{params:Promise<{organizationId:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {organizationId}=await params;
  const path=`/compte/espaces/us/${organizationId}`;
  if(accountUsNavigation(path).destination!==path)notFound();
  const user=await requireZentraUser(path,{offerAccess:false});
  const language=await getSiteLanguage(),c=accountWorkspaceCopy[language];
  const unavailable=()=> <><h1>{c.denied}</h1><p className="account-lead">{c.deniedDetail}</p><a className="account-button secondary" href="/compte/espaces">{c.back}</a></>;
  if(!await accountWorkspaceDiscoveryEnabled())return unavailable();
  const query=await searchParams;
  const setting=typeof query.reglage==='string'?query.reglage:'';
  let data:{workspace:AccountWorkspace;preferences:AccountPreferences|null;erpReadiness:Awaited<ReturnType<typeof usExportReadiness>>|null;bankEnabled:boolean;supplierEnabled:boolean;documentsEnabled:boolean;teamEnabled:boolean;syncEnabled:boolean;taxInvoiceTestEnabled:boolean;supportWorkspaceEnabled:boolean;supportMailboxEnabled:boolean;supportMailImportEnabled:boolean;supportTriageEnabled:boolean;supportTicketsEnabled:boolean;supportWorkerEnabled:boolean}|null=null;
  try {
    const workspaces=await accountWorkspacesForUser(user.userId);
    const workspace=workspaces.find(item=>item.organizationId===organizationId&&item.edition==='us_experimental');
    if(workspace){
      const preferences=setting==='apparence'?await accountPreferences(user.userId):null;
      const erpReadiness=setting==='gestion'?await usExportReadiness():null;
      const bankEnabled=setting==='gestion'?await usBankReadiness():false;
      const documentsEnabled=setting==='gestion'||setting==='support'?await usSupplierDocumentsReadiness():false;
      const teamEnabled=await usTeamEnabled();
      let supportWorkspaceEnabled=false;
      if(await usSupportWorkspacesEnabled()) {
        try { const access=await requireUsWorkspaceAccess(organizationId,user.userId,'support'); supportWorkspaceEnabled=access.organizationId===organizationId&&access.userId===user.userId&&access.role===workspace.role; }
        catch(error) { if(!(error instanceof UsAuthorityError)||![402,403].includes(error.status))throw error; }
      }
      const supportMailboxEnabled=supportWorkspaceEnabled && await usSupportMailboxEnabled();
      const supportMailImportEnabled=supportMailboxEnabled && documentsEnabled && await usSupportMailImportEnabled();
      const supportTriageEnabled=supportMailboxEnabled && await usSupportTriageEnabled();
      const supportTicketsEnabled=supportWorkspaceEnabled && await usSupportTicketsEnabled();
      const supportWorkerEnabled=supportTriageEnabled && supportTicketsEnabled && await usSupportWorkerEnabled();
      const syncEnabled=setting==='gestion'?await usWorkspaceSyncEnabled():false;
      const taxInvoiceTestEnabled=setting==='gestion'?await usTaxInvoiceTestEnabled():false;
      let supplierEnabled=false;
      if(setting==='gestion' && await usSupplierReadiness()) {
        try { const automation=await requireUsWorkspaceAccess(organizationId,user.userId,'automation'); supplierEnabled=automation.organizationId===organizationId && automation.userId===user.userId && automation.role===workspace.role; }
        catch(error) { if(!(error instanceof UsAuthorityError) || ![402,403].includes(error.status))throw error; }
      }
      const access=await requireUsWorkspaceAccess(organizationId,user.userId);
      const current=await getZentraUser({offerAccess:false});
      if(current && current.userId===user.userId && access.organizationId===organizationId && access.userId===user.userId && access.role===workspace.role && await accountWorkspaceDiscoveryEnabled())data={workspace,preferences,erpReadiness,bankEnabled,supplierEnabled,documentsEnabled,teamEnabled,syncEnabled,taxInvoiceTestEnabled,supportWorkspaceEnabled,supportMailboxEnabled,supportMailImportEnabled,supportTriageEnabled,supportTicketsEnabled,supportWorkerEnabled};
    }
  } catch(error) {
    if(!(error instanceof UsAuthorityError) && !(error instanceof AccountWorkspaceDiscoveryError))throw error;
  }
  if(!data)return unavailable();
  const {workspace,preferences,erpReadiness,bankEnabled,supplierEnabled,documentsEnabled,teamEnabled,syncEnabled,taxInvoiceTestEnabled,supportWorkspaceEnabled,supportMailboxEnabled,supportMailImportEnabled,supportTriageEnabled,supportTicketsEnabled,supportWorkerEnabled}=data;
  const settings=<nav className="account-space-settings" aria-label={c.global}>{[{id:'',label:c.overview},{id:'gestion',label:c.management},...(teamEnabled?[{id:'equipe',label:browserUsTeamCopy[language].title}]:[]),...(supportWorkspaceEnabled?[{id:'support',label:'Zentra Support'}]:[]),{id:'profil',label:c.profile},{id:'securite',label:c.security},{id:'apparence',label:c.appearance}].map(item=><a key={item.id} href={`${path}${item.id?`?reglage=${item.id}`:''}`} aria-current={setting===item.id?'page':undefined}>{item.label}</a>)}</nav>;
  // This opt-in reveals only the separate TEST preparation flow. Generic/live
  // issuance stays unavailable; the server still admits every exact request.
  if(setting==='gestion')return <>{settings}<UsErpWorkbench organizationId={organizationId} role={workspace.role} language={language} expectedUserId={user.userId} supportedSchemaVersion={erpReadiness?.supportedSchemaVersion ?? 1} salesEnabled={erpReadiness?.enabled ?? false} invoiceIssuanceAvailable={false} taxInvoiceTestEnabled={taxInvoiceTestEnabled} bankEnabled={bankEnabled} supplierEnabled={supplierEnabled} documentsEnabled={documentsEnabled} teamEnabled={teamEnabled} syncEnabled={syncEnabled} supportWorkspaceEnabled={supportWorkspaceEnabled} supportMailboxEnabled={supportMailboxEnabled} supportMailImportEnabled={supportMailImportEnabled} supportTriageEnabled={supportTriageEnabled} supportTicketsEnabled={supportTicketsEnabled} supportWorkerEnabled={supportWorkerEnabled}/></>;
  if(setting==='support')return supportWorkspaceEnabled?<>{settings}<UsSupportWorkspacePanel workerEnabled={supportWorkerEnabled} ticketsEnabled={supportTicketsEnabled} triageEnabled={supportTriageEnabled} importEnabled={supportMailImportEnabled} documentsHref={`${path}?reglage=gestion#us-supplier-originals`} mailboxEnabled={supportMailboxEnabled} organizationId={organizationId} role={workspace.role} language={language} expectedUserId={user.userId}/></>:unavailable();
  if(setting==='equipe')return teamEnabled?<>{settings}<UsTeamPanel organizationId={organizationId} role={workspace.role} language={language} expectedUserId={user.userId}/></>:unavailable();
  if(setting==='profil')return <>{settings}<h1>{c.profile}</h1><p className="account-lead">{c.settingsDetail}</p><ProfileForms userId={user.userId} name={user.displayName} email={user.email}/></>;
  if(setting==='securite')return <>{settings}<h1>{c.security}</h1><p className="account-lead">{c.settingsDetail}</p><SecurityForms userId={user.userId}/></>;
  if(setting==='apparence'&&preferences)return <>{settings}<h1>{c.appearance}</h1><p className="account-lead">{c.settingsDetail}</p><AppearanceForm preferences={preferences}/></>;
  return <>{settings}<span className="account-space-edition">{c.us}</span><h1>{workspace.name}</h1><p className="account-lead">{c.usLead}</p><section className="account-card"><h2>{c.preparation}</h2><p>{c.preparationDetail}</p><p className="account-caption">{accountWorkspaceRole(language,workspace.role)}</p><a className="account-button" href={`${path}?reglage=gestion`}>{c.management}</a></section><a className="account-button secondary" href="/compte/espaces">{c.back}</a></>;
}
