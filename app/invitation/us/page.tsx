import { UsTeamInvitation } from '@/components/account/us-team-invitation';
import { getZentraUser } from '@/app/zentra-auth';
import { getSiteLanguage } from '@/lib/site-language-server';
import { accountPreferences } from '@/lib/account-preferences';
export const dynamic='force-dynamic';
export const metadata={title:'Zentra',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function UsInvitationPage(){
  const language=await getSiteLanguage();
  let user=await getZentraUser({offerAccess:false,refreshSession:true});
  let theme:'system'|'light'|'dark'='system';
  if(user){
    const preferences=await accountPreferences(user.userId);
    const fresh=await getZentraUser({offerAccess:false,refreshSession:true});
    if(!fresh || fresh.userId!==user.userId)user=null;
    else {user=fresh;if(['system','light','dark'].includes(preferences.theme))theme=preferences.theme;}
  }
  // The secret is a URL fragment: never part of an SSR property or query string.
  return <main className="us-team-public" data-theme={theme}><UsTeamInvitation language={language} expectedUserId={user?.userId??null} authenticatedEmail={user?.email}/></main>;
}
