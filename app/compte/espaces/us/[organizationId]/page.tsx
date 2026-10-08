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
  let data:{workspace:AccountWorkspace;preferences:AccountPreferences|null;erpReadiness:Awaited<ReturnType<typeof usExportReadiness>>|null;bankEnabled:boolean}|null=null;
  try {
    const workspaces=await accountWorkspacesForUser(user.userId);
    const workspace=workspaces.find(item=>item.organizationId===organizationId&&item.edition==='us_experimental');
    if(workspace){
      const preferences=setting==='apparence'?await accountPreferences(user.userId):null;
      const erpReadiness=setting==='gestion'?await usExportReadiness():null;
      const bankEnabled=setting==='gestion'?await usBankReadiness():false;
      const access=await requireUsWorkspaceAccess(organizationId,user.userId);
      const current=await getZentraUser({offerAccess:false});
      if(current && current.userId===user.userId && access.organizationId===organizationId && access.userId===user.userId && access.role===workspace.role && await accountWorkspaceDiscoveryEnabled())data={workspace,preferences,erpReadiness,bankEnabled};
    }
  } catch(error) {
    if(!(error instanceof UsAuthorityError) && !(error instanceof AccountWorkspaceDiscoveryError))throw error;
  }
  if(!data)return unavailable();
  const {workspace,preferences,erpReadiness,bankEnabled}=data;
  const settings=<nav className="account-space-settings" aria-label={c.global}>{[{id:'',label:c.overview},{id:'gestion',label:c.management},{id:'profil',label:c.profile},{id:'securite',label:c.security},{id:'apparence',label:c.appearance}].map(item=><a key={item.id} href={`${path}${item.id?`?reglage=${item.id}`:''}`} aria-current={setting===item.id?'page':undefined}>{item.label}</a>)}</nav>;
  // A configured tax profile is not a provider connection. Real issuance stays
  // closed until the trusted fiscal binding is integrated and validated.
  if(setting==='gestion')return <>{settings}<UsErpWorkbench organizationId={organizationId} role={workspace.role} language={language} expectedUserId={user.userId} supportedSchemaVersion={erpReadiness?.supportedSchemaVersion ?? 1} salesEnabled={erpReadiness?.enabled ?? false} invoiceIssuanceAvailable={false} bankEnabled={bankEnabled}/></>;
  if(setting==='profil')return <>{settings}<h1>{c.profile}</h1><p className="account-lead">{c.settingsDetail}</p><ProfileForms userId={user.userId} name={user.displayName} email={user.email}/></>;
  if(setting==='securite')return <>{settings}<h1>{c.security}</h1><p className="account-lead">{c.settingsDetail}</p><SecurityForms userId={user.userId}/></>;
  if(setting==='apparence'&&preferences)return <>{settings}<h1>{c.appearance}</h1><p className="account-lead">{c.settingsDetail}</p><AppearanceForm preferences={preferences}/></>;
  return <>{settings}<span className="account-space-edition">{c.us}</span><h1>{workspace.name}</h1><p className="account-lead">{c.usLead}</p><section className="account-card"><h2>{c.preparation}</h2><p>{c.preparationDetail}</p><p className="account-caption">{accountWorkspaceRole(language,workspace.role)}</p><a className="account-button" href={`${path}?reglage=gestion`}>{c.management}</a></section><a className="account-button secondary" href="/compte/espaces">{c.back}</a></>;
}
