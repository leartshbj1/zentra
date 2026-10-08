import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getZentraUser } from '@/app/zentra-auth';
import { membershipsForUser } from '@/lib/account';
import { accountPreferences } from '@/lib/account-preferences';
import { getSiteLanguage } from '@/lib/site-language-server';
import { AccountShell } from '@/components/account/account-shell';
import './account.css';
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };
export default async function Layout({ children }: { children: React.ReactNode }) {
  // Shared navigation is a read. Pages which activate an offered access keep
  // their own explicit authentication flow; payment receipts never grant one.
  const user = await getZentraUser({ offerAccess: false });
  // Each page preserves its own return path when authentication is needed.
  if(!user)return children;
  const [organizations, preferences, language] = await Promise.all([membershipsForUser(user.userId), accountPreferences(user.userId), getSiteLanguage()]);
  const current=await getZentraUser({offerAccess:false});
  if(!current||current.userId!==user.userId)redirect('/connexion?retour=%2Fcompte%2Fespaces');
  return <Suspense fallback={<main className="account-loading" aria-live="polite" aria-atomic="true">Ouverture de votre espace…</main>}><AccountShell displayName={user.displayName} email={user.email} organizations={organizations.map(({organizationId,organizationName,role})=>({organizationId,organizationName,role}))} theme={preferences.theme} language={language}>{children}</AccountShell></Suspense>;
}
