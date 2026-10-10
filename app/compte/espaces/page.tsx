import { requireZentraUser, getZentraUser } from '@/app/zentra-auth';
import { accountWorkspacesForUser, accountWorkspaceDiscoveryEnabled, AccountWorkspaceDiscoveryError } from '@/lib/account-workspaces';
import { getSiteLanguage } from '@/lib/site-language-server';
import { WorkspacePicker } from '@/components/account/workspace-picker';
export const dynamic='force-dynamic';
export const metadata={robots:{index:false,follow:false}};
export default async function WorkspacePage() {
  const user=await requireZentraUser('/compte/espaces',{offerAccess:false});
  const language=await getSiteLanguage();
  let workspaces:Awaited<ReturnType<typeof accountWorkspacesForUser>>=[];
  let unavailable=false;
  try {
    const found=await accountWorkspacesForUser(user.userId);
    const current=await getZentraUser({offerAccess:false});
    if(!current || current.userId!==user.userId)unavailable=true;
    else {
      const includeUs=await accountWorkspaceDiscoveryEnabled();
      workspaces=found.filter(item=>includeUs||item.edition==='ch_legacy');
    }
  } catch(error) {
    if(!(error instanceof AccountWorkspaceDiscoveryError)) throw error;
    unavailable=true;
  }
  const usTestSetupAvailable=await(await import('@/lib/international/us-saas-test-bindings')).usTestBillingEnabled();
  return <WorkspacePicker workspaces={workspaces} language={language} unavailable={unavailable} usTestSetupAvailable={usTestSetupAvailable}/>;
}
