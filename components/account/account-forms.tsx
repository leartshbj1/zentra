'use client';
import { useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { notifyAuthChanged } from '@/lib/auth-browser-events';
import type { AccountPreferences } from '@/lib/account-preferences';
import { LEGAL_VERSION } from '@/lib/legal';

export function AccountForm({ endpoint, values, success, children, label = 'Enregistrer', method = 'PUT' }: {
  endpoint: string; values: Record<string, unknown>; success: string; children: ReactNode; label?: string; method?: 'PUT'|'POST';
}) {
  const router = useRouter();
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    const form = event.currentTarget;
    try {
      const fields = Object.fromEntries(new FormData(form));
      const submitted = {...fields, ...(Object.hasOwn(fields,'acceptTerms') ? {acceptTerms:fields.acceptTerms==='on'}:{}), ...values};
      const response = await fetch(endpoint, { method, credentials: 'same-origin', headers: {'Content-Type':'application/json'},
        body: JSON.stringify(submitted), signal: AbortSignal.timeout(25000) });
      const result = await response.json().catch(() => ({})) as {error?:string;url?:string;signedOut?:boolean};
      if (!response.ok) throw new Error(result.error || 'L’enregistrement n’a pas abouti. Réessayez.');
      if (result.url) {
        const url = new URL(result.url);
        if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') throw new Error('Le portail de paiement est indisponible.');
        window.location.assign(url.href); return;
      }
      if (result.signedOut) { notifyAuthChanged(); window.location.assign('/connexion?retour=%2Fcompte%2Fsecurite'); return; }
      // Never retain password values after a successful change.
      for (const input of Array.from(form.querySelectorAll<HTMLInputElement>('input[type=password]'))) input.value = '';
      setNotice(success); router.refresh();
    } catch (reason) { setError(reason instanceof Error && !['TimeoutError','AbortError'].includes(reason.name) ? reason.message : 'La connexion a été interrompue. Vérifiez le résultat avant de réessayer.'); }
    finally { pending.current = false; setBusy(false); }
  }
  return <form className="account-form" onSubmit={event => void submit(event)} aria-busy={busy}>
    <fieldset disabled={busy} className="account-form" style={{border:0,padding:0,margin:0}}>{children}<div><button className="account-button" type="submit" disabled={busy}>{busy ? 'Enregistrement…' : label}</button></div></fieldset>
    {notice && <output className="account-notice">{notice}</output>}{error && <p className="account-notice" role="alert">{error}</p>}
  </form>;
}
export function ProfileForms({userId, name, email}: {userId:string;name:string;email:string}) {
  return <><section className="account-card"><h2>Comment vous appeler ?</h2><AccountForm endpoint="/api/account/profile" values={{action:'name',expectedUserId:userId}} success="Votre nom a été mis à jour."><label>Nom et prénom<input name="displayName" defaultValue={name} autoComplete="name" required maxLength={120}/></label></AccountForm></section>
  <section className="account-card"><h2>Adresse e-mail</h2><p>{email}</p><p className="account-caption">Votre adresse de connexion et de réception des messages de sécurité.</p></section>
  <details><summary>Changer d’adresse e-mail</summary><AccountForm endpoint="/api/account/profile" values={{action:'email',expectedUserId:userId}} success="La demande a été envoyée. Ouvrez les liens reçus sur vos adresses e-mail dans ce même navigateur." label="Envoyer les confirmations"><label>Nouvelle adresse<input name="email" type="email" autoComplete="email" required maxLength={254}/></label><PasswordField/><p className="account-caption">Votre adresse actuelle reste valable tant que le changement n’est pas confirmé.</p></AccountForm></details></>;
}
function PasswordField(){return <label>Mot de passe actuel<input name="currentPassword" type="password" autoComplete="current-password" required maxLength={256}/></label>}
export function SecurityForms({userId}:{userId:string}) {
  return <><section className="account-card"><h2>Changer le mot de passe</h2><AccountForm endpoint="/api/account/profile" values={{action:'password',expectedUserId:userId}} success="Mot de passe modifié." label="Mettre à jour et me reconnecter"><PasswordField/><label>Nouveau mot de passe<input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={256}/></label><p className="account-caption">12 caractères minimum. Après la modification, reconnectez vos appareils avec ce nouveau mot de passe.</p></AccountForm></section>
  <details><summary>Déconnecter mes appareils</summary><AccountForm endpoint="/api/account/profile" values={{action:'signout-all',expectedUserId:userId}} success="Sessions fermées." label="Déconnecter tous mes appareils"><p className="account-caption">Ferme vos sessions sur le site et révoque les connexions de l’application. Vos données restent dans votre entreprise.</p><PasswordField/></AccountForm></details><a className="account-button secondary" href="/mot-de-passe">J’ai oublié mon mot de passe</a></>;
}
export function AppearanceForm({preferences}:{preferences:AccountPreferences}) {
  return <section className="account-card"><h2>Apparence de mon espace</h2><AccountForm endpoint="/api/account/preferences" values={{revision:preferences.revision}} success="Votre apparence a été enregistrée."><label>Thème<select name="theme" defaultValue={preferences.theme}><option value="system">Automatique · comme cet appareil</option><option value="light">Clair</option><option value="dark">Sombre</option></select></label><p className="account-caption">Ce choix s’applique aux paramètres du site. Dans l’application, retrouvez le thème sous Paramètres → Apparence.</p></AccountForm></section>;
}
export function BillingPortalButton({organizationId}:{organizationId:string}) {
  return <AccountForm endpoint="/api/stripe/portal" method="POST" values={{organizationId}} success="Ouverture de la facturation." label="Gérer mon abonnement">{null}</AccountForm>;
}
export function CompanyDraftForm({preferences}:{preferences:AccountPreferences}) {
  return <AccountForm endpoint="/api/complete/trial" method="POST" values={{legalVersion:LEGAL_VERSION}} success="Votre entreprise est prête. Votre essai de 14 jours a commencé." label="Commencer mes 14 jours"><label>Nom de votre entreprise<input name="companyName" defaultValue={preferences.companyDraft} autoComplete="organization" required maxLength={120}/></label><p className="account-caption">14 jours de Gestion, Support et Automation : 3 personnes, titulaire compris, et 250 analyses partagées. Sans engagement et sans carte bancaire. Aucun paiement automatique à la fin de l’essai.</p><label className="account-consent"><input name="acceptTerms" type="checkbox" required/><span>J’accepte les <a href="/conditions" target="_blank" rel="noopener noreferrer">conditions d’utilisation</a>.</span></label></AccountForm>;
}
