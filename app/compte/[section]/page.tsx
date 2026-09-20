import { notFound } from 'next/navigation';
import { requireZentraUser } from '@/app/zentra-auth';
import { membershipsForUser } from '@/lib/account';
import { accountPreferences } from '@/lib/account-preferences';
import { organizationAccess, organizationStats } from '@/lib/account-overview';
import { roleCanManageMembers } from '@/lib/account-security';
import { teamSeats } from '@/lib/team-seats';
import { database } from '@/lib/runtime';
import { TeamInvite } from '@/components/team-invite';
import { TeamAccessList } from '@/components/team-access-list';
import { AppearanceForm, BillingPortalButton, ProfileForms, SecurityForms } from '@/components/account/account-forms';
import { ChevronRight } from 'lucide-react';
export const dynamic = 'force-dynamic';
const SECTIONS: Record<string, { title: string; description: string }> = {
  profil: { title:'Votre profil', description:'Les informations personnelles de votre compte Zentra.' },
  entreprise: { title:'Votre entreprise', description:'Un espace commun pour travailler ensemble.' },
  equipe: { title:'Votre équipe', description:'Invitez vos collaborateurs et choisissez leurs accès.' },
  securite: { title:'Sécurité', description:'Gardez le contrôle de votre compte et de vos appareils.' },
  connexions: { title:'Connexions', description:'Retrouvez les accès de votre entreprise.' },
  apparence: { title:'Apparence', description:'Un espace agréable, à votre façon.' },
  abonnement: { title:'Abonnement et facturation', description:'Votre formule, ses limites et les prochaines échéances.' },
  donnees: { title:'Données et confidentialité', description:'Vos sauvegardes, vos archives et vos droits.' },
};
const roleLabel: Record<string,string> = {owner:'Propriétaire',admin:'Administrateur',accountant:'Comptable',member:'Collaborateur',read_only:'Lecture seule'};
const date = (value: number|null) => value ? new Intl.DateTimeFormat('fr-CH',{dateStyle:'long',timeZone:'Europe/Zurich'}).format(value*1000) : '—';
export default async function Page({params,searchParams}:{params:Promise<{section:string}>;searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const {section} = await params;
  const info = SECTIONS[section]; if (!info) notFound();
  const query = await searchParams;
  const user = await requireZentraUser(`/compte/${section}`);
  const organizations = await membershipsForUser(user.userId);
  const selected = typeof query.organizationId === 'string' ? query.organizationId : organizations[0]?.organizationId;
  const org = organizations.find(item => item.organizationId === selected);
  if (selected && !org) notFound();
  const head = <><h1>{info.title}</h1><p className="account-lead">{info.description}</p></>;
  if(section==='profil') return <>{head}<ProfileForms userId={user.userId} name={user.displayName} email={user.email}/></>;
  if(section==='securite') return <>{head}<SecurityForms userId={user.userId}/></>;
  if(section==='apparence') return <>{head}<AppearanceForm preferences={await accountPreferences(user.userId)}/></>;
  if(!org) return <>{head}<section className="account-card account-empty"><h2>Aucune entreprise reliée</h2><p>Choisissez une formule ou ouvrez l’invitation de votre équipe.</p><div className="account-actions"><a className="account-button" href="/pricing">Voir les formules</a><a className="account-button secondary" href="/compte">Préparer mon espace</a></div></section></>;
  const orgQuery = `?organizationId=${encodeURIComponent(org.organizationId)}`;
  if(section==='entreprise') {
    const [seats,stats] = await Promise.all([teamSeats(org.organizationId),organizationStats(org.organizationId)]);
    return <>{head}<section className="account-card"><h2>{org.organizationName}</h2><dl><div className="account-row"><dt>Votre rôle</dt><dd>{roleLabel[org.role]}</dd></div><div className="account-row"><dt>Personnes dans l’équipe</dt><dd>{seats.used}{seats.limit ? ` / ${seats.limit}`:''}</dd></div><div className="account-row"><dt>Appareils connectés</dt><dd>{stats.devices}</dd></div></dl></section><section className="account-card"><h2>Configurer l’entreprise</h2><p className="account-caption">Dans Zentra Gestion, ouvrez Paramètres → Entreprise pour renseigner vos coordonnées, votre logo et la TVA. Ces informations sont partagées avec votre équipe.</p><div className="account-actions"><a className="account-button" href="/download">Retrouver l’application</a><a className="account-button secondary" href={`/compte/equipe${orgQuery}`}>Gérer l’équipe</a></div></section></>;
  }
  if(section==='equipe'||section==='connexions') {
    const [seats,access] = await Promise.all([teamSeats(org.organizationId), organizationAccess(org.organizationId)]);
    const canManage = roleCanManageMembers(org.role);
    return <>{head}<section className="account-card"><h2>{org.organizationName}</h2><p className="account-caption">{seats.used}{seats.limit ? ` / ${seats.limit}` : ''} personnes · titulaire compris{seats.reserved ? ` · ${seats.reserved} invitation(s) en attente`:''}</p><TeamAccessList organizationId={org.organizationId} currentUserId={user.userId} canManage={canManage} canRemoveAdmins={org.role==='owner'} members={section==='equipe'?access.members:[]} devices={section==='connexions'?access.devices.filter(item => canManage||item.userId===user.userId):[]} invitations={section==='equipe'&&canManage?access.invitations:[]} visibleSection={section==='equipe'?'team':'devices'}/></section>{section==='equipe'&&canManage&&<section className="account-card"><TeamInvite organizationId={org.organizationId} seats={seats}/></section>}{section==='connexions'&&<section className="account-card"><a className="account-link-row" href="/support/espace"><span>Zentra Support<small>Vos logiciels de support et boîtes e-mail.</small></span><ChevronRight size={18}/></a><a className="account-link-row" href={`/compte/automation${orgQuery}`}><span>Zentra Automation<small>Fonctions activées pour cette entreprise.</small></span><ChevronRight size={18}/></a></section>}</>;
  }
  if(section==='abonnement') {
    const [seats,sub] = await Promise.all([teamSeats(org.organizationId),database().prepare('SELECT status,current_period_end,cancel_at_period_end,entitlement_valid_until,customer_id,last_payment_failure_at,last_paid_at FROM subscriptions WHERE subscription_id=?').bind(org.subscriptionId).first<{status:string;current_period_end:number;cancel_at_period_end:number;entitlement_valid_until:number;customer_id:string;last_payment_failure_at:number|null;last_paid_at:number|null}>()]);
    const failed = Boolean(sub?.last_payment_failure_at && sub.last_payment_failure_at > (sub.last_paid_at || 0));
    const offered = seats.manualAccess || seats.offeredUntil || seats.trialUntil;
    const status = seats.trialUntil ? (seats.subscriptionActive ? 'Essai gratuit' : 'Essai terminé') : offered ? (seats.subscriptionActive?'Accès offert':'Accès offert terminé') : failed ? 'Paiement à régulariser' : sub?.cancel_at_period_end ? 'Résiliation programmée' : !seats.subscriptionActive ? 'Accès expiré' : 'Actif';
    return <>{head}<section className="account-card"><h2>{seats.planName}</h2><dl><div className="account-row"><dt>Statut</dt><dd>{status}</dd></div><div className="account-row"><dt>Prix mensuel</dt><dd>{seats.priceChfCents/100} CHF</dd></div><div className="account-row"><dt>Personnes incluses</dt><dd>{seats.limit ?? 'Sans limite'} · titulaire compris</dd></div><div className="account-row"><dt>{offered||sub?.cancel_at_period_end?'Fin de l’accès':'Période en cours jusqu’au'}</dt><dd>{date(seats.trialUntil || seats.offeredUntil || sub?.current_period_end || null)}</dd></div></dl>{failed&&<p className="account-notice" role="alert">Vérifiez votre moyen de paiement dans le portail de facturation. Les données de votre entreprise sont conservées.</p>}<div className="account-actions">{org.role==='owner'&&sub&&/^cus_[A-Za-z0-9_]+$/.test(sub.customer_id)?<BillingPortalButton organizationId={org.organizationId}/>:<a className="account-button secondary" href="/pricing">Voir les formules</a>}</div><p className="account-caption">{org.role==='owner'?'Vos factures et les changements disponibles sont présentés dans le portail sécurisé. Le prix et la date d’effet sont indiqués avant confirmation.':'Seul le propriétaire de cette entreprise peut modifier son abonnement.'}</p></section></>;
  }
  return <>{head}<section className="account-card"><h2>Vos documents</h2>{['owner','admin'].includes(org.role)&&<a className="account-link-row" href={`/compte/sauvegardes${orgQuery}`}><span>Sauvegardes de l’entreprise<small>Consulter les copies conservées dans le coffre.</small></span><ChevronRight size={18}/></a>}<a className="account-link-row" href={`/compte/archives${orgQuery}`}><span>Factures archivées<small>Rechercher et télécharger vos pièces.</small></span><ChevronRight size={18}/></a><a className="account-link-row" href="/confidentialite"><span>Confidentialité<small>Utilisation et conservation de vos données.</small></span><ChevronRight size={18}/></a></section><section className="account-card"><h2>Suppression de compte</h2><p className="account-caption">La suppression doit prendre en compte les entreprises dont vous êtes propriétaire, les abonnements et les documents à conserver. Contactez-nous pour préparer cette opération sans supprimer les données de vos collaborateurs.</p><a className="account-button secondary" href="mailto:info@zentraapp.ch?subject=Suppression%20de%20mon%20compte%20Zentra">Demander la suppression</a></section></>;
}
