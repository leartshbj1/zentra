'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import type { PrepaidReceipt, PrepaidReceiptStatus } from '@/lib/payments/prepaid-receipt-types';
import { prepaidReceiptPath } from '@/lib/payments/prepaid-receipt-types';
import { SITE_LANGUAGE_TAGS, type SiteLanguage } from '@/lib/site-language';
import './payment-receipt.css';

const copy: Record<PrepaidReceiptStatus, { title: string; description: string }> = {
  pending: { title: 'Confirmation en cours', description: 'Votre paiement est en cours de vérification. Cette page se met à jour automatiquement.' },
  verification_required: { title: 'Vérification en cours', description: 'Le résultat doit encore être vérifié. Ne relancez pas un nouveau paiement.' },
  activation_pending: { title: 'Paiement confirmé', description: 'Nous terminons l’activation de votre abonnement. Cette page se met à jour automatiquement.' },
  active: { title: 'Votre abonnement est actif', description: 'Votre équipe retrouve ses accès dans le même espace.' },
  ended: { title: 'Période terminée', description: 'Ce paiement est enregistré. Consultez votre abonnement pour connaître vos accès actuels.' },
  refunded: { title: 'Paiement à régulariser', description: 'Ce paiement ne permet plus d’ouvrir l’accès. Consultez votre abonnement.' },
  not_completed: { title: 'Paiement non terminé', description: 'Cette demande est terminée sans activation. Retrouvez vos options dans votre abonnement.' },
  test_confirmed: { title: 'Paiement de test confirmé', description: 'Cet essai n’active aucun accès payé dans Zentra.' },
};

export function PaymentReceipt({ intentId, initial, language = 'fr' }: {
  intentId: string; initial: PrepaidReceipt | null; language?: SiteLanguage;
}) {
  const [receipt, setReceipt] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [notice, setNotice] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const currentController = useRef<AbortController | null>(null);
  const requests = useRef(0);
  const stopped = useRef(false);
  const locale = SITE_LANGUAGE_TAGS[language];
  const date = (value: number) => new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeZone: 'Europe/Zurich' }).format(value * 1000);
  const clearPrivateReceipt = useCallback((status: number) => {
    stopped.current = true; setAutomatic(false); setReceipt(null); setAccepted(false); setNotice(''); setAuthRequired(status === 401);
  }, []);
  const refresh = useCallback(async (manual = false, resumed = false) => {
    if (inFlight.current || !mounted.current || (!manual && ((!resumed && stopped.current) || document.visibilityState !== 'visible'))) return;
    inFlight.current = true;
    const controller = new AbortController(); currentController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    if (manual) { setBusy(true); setError(''); }
    try {
      const response = await fetch(`/api/payments/postfinance/receipt?achat=${encodeURIComponent(intentId)}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const result = await response.json() as PrepaidReceipt & { code?: string };
      if (!mounted.current) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          clearPrivateReceipt(response.status);
          throw new Error(response.status === 401 ? 'Reconnectez-vous pour vérifier ce paiement.' : 'Ce paiement n’est pas accessible depuis ce compte.');
        }
        throw new Error('Le suivi est momentanément indisponible. Réessayez sans créer de nouveau paiement.');
      }
      if (result.intentId !== intentId) { clearPrivateReceipt(404); throw new Error('Ce paiement n’est pas accessible depuis ce compte.'); }
      setReceipt(result); setError(''); setAuthRequired(false);
      if (!result.poll) { stopped.current = true; setAutomatic(false); }
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Le suivi est momentanément indisponible. Réessayez sans créer de nouveau paiement.');
      else if (mounted.current && manual) setError('La réponse tarde. Vérifiez de nouveau le résultat sans relancer le paiement.');
    } finally {
      window.clearTimeout(timeout);
      inFlight.current = false; currentController.current = null;
      if (mounted.current) {
        setBusy(false);
        if (!manual && !resumed && ++requests.current >= 12) { stopped.current = true; setAutomatic(false); }
      }
    }
  }, [intentId, clearPrivateReceipt]);

  useEffect(() => {
    mounted.current = true;
    stopped.current = initial ? !initial.poll : false;
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(false, true); };
    document.addEventListener('visibilitychange', visible);
    const firstRead = !initial ? window.setTimeout(() => void refresh(), 0) : null;
    return () => { mounted.current = false; window.clearInterval(timer); if (firstRead !== null) window.clearTimeout(firstRead); document.removeEventListener('visibilitychange', visible); currentController.current?.abort(); };
  }, [initial, refresh]);

  async function cancel() {
    if (!receipt?.contractId || !receipt.canCancel || !accepted || inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setNotice('');
    const controller = new AbortController(); currentController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    let confirmed = false;
    try {
      const response = await fetch('/api/payments/postfinance/cancel', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractId: receipt.contractId }), signal: controller.signal,
      });
      const result = await response.json() as { cancelled?: boolean; error?: string };
      if (response.status === 401 || response.status === 403 || response.status === 404) clearPrivateReceipt(response.status);
      if (!response.ok || result.cancelled !== true) throw new Error(result.error || 'L’arrêt du renouvellement doit être vérifié. Réessayez dans quelques instants.');
      if (mounted.current) {
        setNotice('Le renouvellement est arrêté. Les périodes déjà payées sont conservées.');
        setReceipt({ ...receipt, cancelAtPeriodEnd: true, canCancel: false }); setAccepted(false);
        confirmed = true;
      }
    } catch (failure) {
      if (mounted.current) setError(controller.signal.aborted ? 'La réponse tarde. Vérifiez de nouveau le résultat sans relancer le paiement.' : failure instanceof Error ? failure.message : 'L’arrêt du renouvellement doit être vérifié. Réessayez dans quelques instants.');
    } finally {
      window.clearTimeout(timeout); inFlight.current = false; currentController.current = null;
      if (mounted.current) setBusy(false);
      if (confirmed && mounted.current) await refresh(false, true);
    }
  }

  const state = receipt ? copy[receipt.status] : null;
  const Icon = receipt?.status === 'active' || receipt?.status === 'test_confirmed' ? CheckCircle2
    : receipt?.poll ? Clock3 : ShieldAlert;
  return <section className="payment-receipt" aria-busy={busy}>
    <Icon size={36} className="payment-receipt-symbol" aria-hidden="true" />
    <h1>{state?.title ?? 'Votre paiement'}</h1>
    {receipt?.environment === 'TEST' && <p className="payment-receipt-message">Paiement de test · aucun accès payé</p>}
    {state && <output className="payment-receipt-lead">{state.description}</output>}
    {!receipt && !error && <output>Vérification…</output>}
    {receipt && <dl className="payment-receipt-details">
      <div><dt>Formule</dt><dd>{receipt.name}</dd></div>
      <div><dt>{receipt.organization ? 'Entreprise' : 'Espace Support'}</dt><dd>{receipt.organization?.name ?? receipt.workspace?.name}</dd></div>
      <div><dt>Prix mensuel</dt><dd>{new Intl.NumberFormat(locale, { style: 'currency', currency: 'CHF' }).format(receipt.priceChfMinor / 100)}</dd></div>
      <div><dt>Moyen de paiement</dt><dd>{receipt.method === 'twint' ? 'TWINT' : 'PostFinance Pay'}</dd></div>
      {receipt.purchasedPeriod && <div><dt>Période de cet achat</dt><dd>{date(receipt.purchasedPeriod.from)} — {date(receipt.purchasedPeriod.until)}</dd></div>}
      {receipt.status === 'active' && receipt.paidUntil && <div><dt>Accès payé jusqu’au</dt><dd>{date(receipt.paidUntil)}</dd></div>}
    </dl>}
    {receipt?.cancelAtPeriodEnd && <p className="payment-receipt-message">Renouvellement arrêté</p>}
    {receipt?.poll && !automatic && <p className="payment-receipt-message">La confirmation prend plus de temps. Vous pouvez revenir ici ou vérifier de nouveau.</p>}
    {notice && <output className="payment-receipt-message">{notice}</output>}
    {error && <p role="alert" className="payment-receipt-error">{error}</p>}
    <div className="payment-receipt-actions">
      {receipt && <a className="account-button" href={receipt.subscriptionHref}>Voir mon abonnement</a>}
      {(!receipt || receipt.poll || error) && <button className="account-button secondary" disabled={busy} onClick={() => void refresh(true)}>{busy ? 'Vérification…' : 'Vérifier le résultat'}</button>}
      {authRequired && <a className="account-button secondary" href={`/connexion?retour=${encodeURIComponent(prepaidReceiptPath(intentId))}`}>Se reconnecter</a>}
      {!receipt && <a href="/compte" className="payment-receipt-link">Retour au compte</a>}
    </div>
    {receipt?.canCancel && <details className="payment-receipt-cancel">
      <summary>Arrêter le renouvellement</summary>
      <p>Les périodes déjà payées restent disponibles. Un paiement déjà envoyé peut encore être traité.</p>
      <label><input type="checkbox" checked={accepted} disabled={busy} onChange={event => setAccepted(event.target.checked)} /><span>Je souhaite arrêter les prochains renouvellements de cet abonnement.</span></label>
      <button className="account-button secondary" disabled={busy || !accepted} onClick={() => void cancel()}>Confirmer l’arrêt</button>
    </details>}
  </section>;
}
