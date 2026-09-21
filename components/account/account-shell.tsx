'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { Building2, ChevronLeft, ChevronRight, CreditCard, Download, Fingerprint, Link2, ShieldCheck, Sparkles, UserRound, UsersRound, Palette } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OrganizationMembership } from '@/lib/account';
import { ZentraSignOut } from '@/components/zentra-sign-out';
export const ACCOUNT_SECTIONS = [
  { id: 'profil', label: 'Profil', detail: 'Votre nom et votre adresse e-mail', icon: UserRound },
  { id: 'entreprise', label: 'Entreprise', detail: 'Votre espace de travail', icon: Building2 },
  { id: 'equipe', label: 'Équipe', detail: 'Collaborateurs et invitations', icon: UsersRound },
  { id: 'securite', label: 'Sécurité', detail: 'Mot de passe et sessions', icon: Fingerprint },
  { id: 'connexions', label: 'Connexions', detail: 'Appareils et produits connectés', icon: Link2 },
  { id: 'apparence', label: 'Apparence', detail: 'Clair, sombre ou automatique', icon: Palette },
  { id: 'abonnement', label: 'Abonnement', detail: 'Formule, factures et renouvellement', icon: CreditCard },
  { id: 'automation', label: 'Automation', detail: 'Réglages et activité de l’entreprise', icon: Sparkles },
  { id: 'donnees', label: 'Données et confidentialité', detail: 'Sauvegardes, archives et droits', icon: ShieldCheck },
];
export function AccountShell({ children, displayName, email, organizations, theme }: {
  children: ReactNode; displayName: string; email: string; organizations: OrganizationMembership[];
  theme: 'system' | 'light' | 'dark';
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const selected = params.get('organizationId') || params.get('entreprise') || organizations[0]?.organizationId || '';
  const organization = organizations.find(item => item.organizationId === selected);
  const query = organization ? `?organizationId=${encodeURIComponent(organization.organizationId)}` : '';
  const isIndex = pathname === '/compte' || pathname === '/compte/';
  return <div className={`account-experience ${isIndex ? 'account-index' : 'account-detail'} ${!organizations.length ? 'account-onboarding' : ''}`} data-theme={theme}>
    <header className="account-topbar"><a href="/" className="account-brand">Zentra<span>Mon espace</span></a><a className="account-download" href="/download"><Download size={17} />L’application</a></header>
    <div className="account-workspace">
      <aside className="account-sidebar" aria-label="Paramètres du compte">
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{displayName.slice(0,1).toUpperCase()}</span><div><strong>{displayName}</strong><p>{email}</p></div></div>
        {organizations.length > 1 && <label className="account-company-switch">Entreprise<select value={organization?.organizationId || ''} onChange={event => window.location.assign(`${pathname}?organizationId=${encodeURIComponent(event.target.value)}`)}><option value="" disabled>Choisir une entreprise</option>{organizations.map(item => <option key={item.organizationId} value={item.organizationId}>{item.organizationName}</option>)}</select></label>}
        <nav>{ACCOUNT_SECTIONS.map(item => <a key={item.id} href={`/compte/${item.id}${query}`} aria-current={pathname === `/compte/${item.id}` ? 'page' : undefined}><item.icon size={20}/><span><strong>{item.label}</strong><small>{item.detail}</small></span><ChevronRight size={16} className="account-nav-chevron"/></a>)}</nav>
        <div className="account-signout"><ZentraSignOut provider="supabase" returnTo="/connexion" /></div>
      </aside>
      <main className="account-content" id="account-content"><a className="account-back" href={`/compte${query}`}><ChevronLeft size={19}/>Paramètres</a>{children}</main>
    </div>
  </div>;
}
