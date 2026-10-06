import { Suspense } from 'react';
import { getZentraUser } from '@/app/zentra-auth';
import { membershipsForUser } from '@/lib/account';
import { accountPreferences } from '@/lib/account-preferences';
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
  const [organizations, preferences] = await Promise.all([membershipsForUser(user.userId), accountPreferences(user.userId)]);
  return <Suspense fallback={<main className="account-loading" aria-live="polite" aria-atomic="true">Ouverture de votre espace…</main>}><AccountShell displayName={user.displayName} email={user.email} organizations={organizations} theme={preferences.theme}>{children}</AccountShell></Suspense>;
}
