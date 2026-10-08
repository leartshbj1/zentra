'use client';
import { usePathname, useSearchParams } from 'next/navigation';
import { Building2, ChevronLeft, ChevronRight, CreditCard, Download, Fingerprint, Link2, ShieldCheck, Sparkles, UserRound, UsersRound, Palette } from 'lucide-react';
import type { ReactNode } from 'react';
import type { OrganizationMembership } from '@/lib/account';
import { ZentraSignOut } from '@/components/zentra-sign-out';
import { SiteLanguagePicker } from '@/components/site-language-picker';
import { accountUsNavigation } from '@/lib/account-workspace-navigation';
import { accountWorkspaceCopy } from '@/lib/account-workspace-copy';
import type { SiteLanguage } from '@/lib/site-language';
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
export function AccountShell({ children, displayName, email, organizations, theme, language='fr' }: {
  children?: ReactNode; displayName: string; email: string; organizations: Pick<OrganizationMembership,'organizationId'|'organizationName'|'role'>[];
  language?:SiteLanguage;
  theme: 'system' | 'light' | 'dark';
}) {
  const pathname = usePathname();
  const params = useSearchParams();
  const us=accountUsNavigation(pathname);
  const copy=accountWorkspaceCopy[language];
  const selected = params.get('organizationId') || params.get('entreprise') || organizations[0]?.organizationId || '';
  const organization = us.isUs ? undefined : organizations.find(item => item.organizationId === selected);
  const query = organization ? `?organizationId=${encodeURIComponent(organization.organizationId)}` : '';
  const isSpaces=pathname==='/compte/espaces'||pathname==='/compte/espaces/';
  const isIndex = pathname === '/compte' || pathname === '/compte/';
  return <div className={`account-experience ${isIndex ? 'account-index' : 'account-detail'} ${!organizations.length&&!us.isUs&&!isSpaces ? 'account-onboarding' : ''}`} data-theme={theme}>
    <a className="account-skip" href="#account-content">{copy.skip}</a>
    <header className="account-topbar"><a href="/" className="account-brand">Zentra<span>{copy.account}</span></a>{!us.isUs&&<a className="account-download" href="/download"><Download size={17} />{copy.download}</a>}<SiteLanguagePicker /></header>
    <div className="account-workspace">
      <aside className="account-sidebar" aria-label={copy.settings}>
        <div className="account-identity"><span className="account-avatar" aria-hidden="true">{displayName.slice(0,1).toUpperCase()}</span><div><strong>{displayName}</strong><p>{email}</p></div></div>
        {!us.isUs&&!isSpaces&&organizations.length > 1 && <label className="account-company-switch">{copy.enterprise}<select value={organization?.organizationId || ''} onChange={event => window.location.assign(`${pathname}?organizationId=${encodeURIComponent(event.target.value)}`)}><option value="" disabled>{copy.chooseCompany}</option>{organizations.map(item => <option key={item.organizationId} value={item.organizationId}>{item.organizationName}</option>)}</select></label>}
        <nav><a href="/compte/espaces" aria-current={isSpaces?'page':undefined}><Building2 size={20}/><span><strong>{copy.spaces}</strong></span><ChevronRight size={16} className="account-nav-chevron"/></a>{us.isUs?us.destination&&[{id:'',label:copy.overview},{id:'profil',label:copy.profile},{id:'securite',label:copy.security},{id:'apparence',label:copy.appearance}].map(item=><a key={item.id} href={`${us.destination}${item.id?`?reglage=${item.id}`:''}`} aria-current={(params.get('reglage')||'')===item.id?'page':undefined}><span><strong>{item.label}</strong></span><ChevronRight size={16} className="account-nav-chevron"/></a>):ACCOUNT_SECTIONS.map(item => <a key={item.id} href={`/compte/${item.id}${query}`} aria-current={pathname === `/compte/${item.id}` || pathname.startsWith(`/compte/${item.id}/`) ? 'page' : undefined}><item.icon size={20}/><span><strong>{item.label}</strong><small>{item.detail}</small></span><ChevronRight size={16} className="account-nav-chevron"/></a>)}</nav>
        <div className="account-signout"><ZentraSignOut provider="supabase" returnTo="/connexion" /></div>
      </aside>
      <main className="account-content" id="account-content" tabIndex={-1}><a className="account-back" href={us.isUs||isSpaces?'/compte/espaces':`/compte${query}`}><ChevronLeft size={19}/>{us.isUs||isSpaces?copy.spaces:copy.settingsTitle}</a>{children}</main>
    </div>
  </div>;
}
