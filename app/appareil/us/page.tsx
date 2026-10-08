import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getZentraUser } from '@/app/zentra-auth';
import { accountWorkspacesForUser } from '@/lib/account-workspaces';
import { loadUsApprovalPage } from '@/lib/international/us-device-approval-page';
import { usNativeAdmissionEnabled } from '@/lib/international/us-device-bindings';
import { UsDeviceApproval } from '@/components/us-device-approval';
import { usApprovalCopy } from '@/lib/international/us-device-approval-copy';

export const dynamic = 'force-dynamic';
export default async function UsDevicePage({ searchParams }: { searchParams: Promise<{ code?: string; lang?: string }> }) {
  const state = await loadUsApprovalPage({ enabled:usNativeAdmissionEnabled, user:() => getZentraUser({ refreshSession:true, offerAccess:false }), discover:userId => accountWorkspacesForUser(userId) }, await searchParams);
  if (state.status === 'unauthenticated') redirect('/connexion?retour=' + encodeURIComponent(state.returnTo));
  const c = usApprovalCopy[state.language];
  return <main className="site-task-page apple-task-page us-device-page" lang={state.language}><div className="apple-task-wrap">
    <a href="/compte" className="apple-task-return"><ArrowLeft size={17} aria-hidden="true" />Zentra</a>
    <h1 className="apple-task-title">{c.title}</h1>
    {state.status === 'ready' ? <><p className="apple-task-lead">{c.lead}</p><p className="us-device-account">{c.connected} : <strong>{state.user.email}</strong></p><UsDeviceApproval key={state.user.userId} userId={state.user.userId} initialCode={state.initialCode} workspaces={state.workspaces} language={state.language} /></> : <section className="apple-task-panel us-device"><p role={state.status === 'unavailable' ? 'alert' : undefined}>{state.status === 'disabled' ? c.disabled : c.unavailable}</p><a href="/compte" className="zentra-text-link">{c.account}</a></section>}
  </div></main>;
}
