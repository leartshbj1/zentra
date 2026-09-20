import { Suspense } from 'react';
import { getZentraUser } from '@/app/zentra-auth';
import { membershipsForUser } from '@/lib/account';
import { accountPreferences } from '@/lib/account-preferences';
import { AccountShell } from '@/components/account/account-shell';
import './account.css';
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false, follow: false } };
export default async function Layout({ children }: { children: React.ReactNode }) {
  const user = await getZentraUser();
  // Each page preserves its own return path when authentication is needed.
  if(!user)return children;
  const [organizations, preferences] = await Promise.all([membershipsForUser(user.userId), accountPreferences(user.userId)]);
  return <Suspense fallback={<main className="account-loading" role="status">Ouverture de votre espace…</main>}><AccountShell displayName={user.displayName} email={user.email} organizations={organizations} theme={preferences.theme}>{children}</AccountShell></Suspense>;
}
