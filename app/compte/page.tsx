import { QuickStart } from '@/components/account/subscription-overview';
import { subscriptionJourney } from '@/lib/complete/journey';
import { requireZentraUser } from '@/app/zentra-auth';
import { membershipsForUser } from '@/lib/account';
import { accountPreferences } from '@/lib/account-preferences';
import { CompanyDraftForm } from '@/components/account/account-forms';
import { ChevronRight, Building2, Download, Sparkles } from 'lucide-react';
export const dynamic = 'force-dynamic';
export default async function AccountPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const user = await requireZentraUser('/compte');
  const [organizations, preferences] = await Promise.all([membershipsForUser(user.userId), accountPreferences(user.userId)]);
  const query=await searchParams; const current=organizations.find(o=>o.organizationId===query.organizationId)||organizations[0];
  const journey=current?await subscriptionJourney({...current,userId:user.userId,founder:false}):null;
  return <><h1>Bienvenue, {user.displayName.split(' ')[0]}.</h1><p className="account-lead">Votre compte, votre entreprise et vos accès. Tout est ici.</p>
    {!organizations.length ? <><section className="account-card"><p className="account-onboarding-step">Bienvenue dans Zentra</p><h2>Préparons votre entreprise.</h2><CompanyDraftForm preferences={preferences}/></section><section className="account-card"><h2>Votre prochaine étape</h2><a className="account-link-row" href="/pricing"><Building2 size={22}/><span>Choisir une formule<small>Solo, Start et Pro : comparez les accès inclus.</small></span><ChevronRight size={18}/></a><a className="account-link-row" href="/download"><Download size={22}/><span>Installer Zentra Gestion<small>Configurez vos coordonnées dans l’application.</small></span><ChevronRight size={18}/></a><p className="account-caption">Invité par votre équipe ? Ouvrez le lien d’invitation reçu avec ce même compte.</p></section></>
    : <>{journey&&<QuickStart key={journey.organizationId} initial={journey}/>}<section className="account-card"><h2>Mes entreprises</h2>{organizations.map(org => <a key={org.organizationId} className="account-link-row" href={`/compte/entreprise?organizationId=${encodeURIComponent(org.organizationId)}`}><Building2 size={22}/><span>{org.organizationName}<small>{org.role === 'owner' ? 'Propriétaire' : 'Espace partagé'}</small></span><ChevronRight size={18}/></a>)}</section><section className="account-card"><h2>Votre quotidien</h2><a className="account-link-row" href="/support/espace"><ChevronRight size={22}/><span>Zentra Support<small>Votre boîte de réception et les actions de votre équipe.</small></span><ChevronRight size={18}/></a><a className="account-link-row" href="/download"><Download size={22}/><span>Ouvrir Zentra Gestion<small>Retrouvez vos devis, factures et projets dans l’application.</small></span><ChevronRight size={18}/></a><a className="account-link-row" href="/compte/automation"><Sparkles size={22}/><span>Zentra Automation<small>Réglages et activité de vos automatisations.</small></span><ChevronRight size={18}/></a></section></>}
  </>;
}
