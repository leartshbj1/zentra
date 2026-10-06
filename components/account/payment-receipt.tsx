'use client';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { CheckCircle2, Clock3, ShieldAlert } from 'lucide-react';
import type {
  PrepaidReceipt,
  PrepaidReceiptStatus,
} from '@/lib/payments/prepaid-receipt-types';
import { prepaidReceiptPath } from '@/lib/payments/prepaid-receipt-types';
import { SITE_LANGUAGE_TAGS, type SiteLanguage } from '@/lib/site-language';
import './payment-receipt.css';

const copy: Record<
  PrepaidReceiptStatus,
  { title: string; description: string }
> = {
  pending: {
    title: 'Confirmation en cours',
    description:
      'Votre paiement est en cours de vérification. Cette page se met à jour automatiquement.',
  },
  verification_required: {
    title: 'Vérification en cours',
    description:
      'Le résultat doit encore être vérifié. Ne relancez pas un nouveau paiement.',
  },
  activation_pending: {
    title: 'Paiement confirmé',
    description:
      'Nous terminons l’activation de votre abonnement. Cette page se met à jour automatiquement.',
  },
  active: {
    title: 'Votre abonnement est actif',
    description: 'Votre équipe retrouve ses accès dans le même espace.',
  },
  ended: {
    title: 'Période terminée',
    description:
      'Ce paiement est enregistré. Consultez votre abonnement pour connaître vos accès actuels.',
  },
  refunded: {
    title: 'Paiement à régulariser',
    description:
      'Ce paiement ne permet plus d’ouvrir l’accès. Consultez votre abonnement.',
  },
  not_completed: {
    title: 'Paiement non terminé',
    description:
      'Cette demande est terminée sans activation. Retrouvez vos options dans votre abonnement.',
  },
  test_confirmed: {
    title: 'Paiement de test confirmé',
    description: 'Cet essai n’active aucun accès payé dans Zentra.',
  },
};
const recoveryCopy: Record<
  SiteLanguage,
  {
    action: string;
    busy: string;
    tracking: string;
    verification: string;
    unavailable: string;
    limited: string;
    timeout: string;
  }
> = {
  fr: {
    action: 'Retrouver le paiement',
    busy: 'Recherche…',
    tracking: 'Tentative retrouvée.',
    verification:
      'Le résultat reste à vérifier. Ne créez pas un nouveau paiement.',
    unavailable:
      'La recherche est indisponible. Réessayez ici dans quelques instants.',
    limited: 'Trop de vérifications. Réessayez dans 30 minutes.',
    timeout: 'La réponse tarde. Réessayez ici sans créer de nouveau paiement.',
  },
  de: {
    action: 'Zahlung wiederfinden',
    busy: 'Suche…',
    tracking: 'Zahlungsversuch gefunden.',
    verification:
      'Das Ergebnis muss noch geprüft werden. Starten Sie keine neue Zahlung.',
    unavailable:
      'Die Suche ist nicht verfügbar. Versuchen Sie es hier später erneut.',
    limited: 'Zu viele Prüfungen. Versuchen Sie es in 30 Minuten erneut.',
    timeout:
      'Die Antwort verzögert sich. Versuchen Sie es hier erneut, ohne eine neue Zahlung zu starten.',
  },
  it: {
    action: 'Ritrovare il pagamento',
    busy: 'Ricerca…',
    tracking: 'Tentativo ritrovato.',
    verification:
      'Il risultato deve ancora essere verificato. Non avviare un nuovo pagamento.',
    unavailable: 'La ricerca non è disponibile. Riprova qui tra poco.',
    limited: 'Troppe verifiche. Riprova tra 30 minuti.',
    timeout: 'La risposta tarda. Riprova qui senza avviare un nuovo pagamento.',
  },
  en: {
    action: 'Find this payment',
    busy: 'Searching…',
    tracking: 'Payment attempt found.',
    verification:
      'The result still needs verification. Do not start a new payment.',
    unavailable: 'Search is unavailable. Try again here shortly.',
    limited: 'Too many checks. Try again in 30 minutes.',
    timeout:
      'The response is taking longer. Try again here without starting a new payment.',
  },
};

export function PaymentReceipt({
  intentId,
  initial,
  language = 'fr',
  canRecover = false,
}: {
  intentId: string;
  initial: PrepaidReceipt | null;
  language?: SiteLanguage;
  canRecover?: boolean;
}) {
  const [receiptState, setReceipt] = useState(initial);
  const receipt = receiptState?.intentId === intentId ? receiptState : null;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const [notice, setNotice] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const [serverInitial, setServerInitial] = useState(initial);
  if (serverInitial !== initial) {
    setServerInitial(initial);
    if (initial !== null) {
      setReceipt(initial);
      setError('');
      setAuthRequired(false);
      if (!initial.poll) setAutomatic(false);
    }
  }
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const currentController = useRef<AbortController | null>(null);
  const recoveryController = useRef<AbortController | null>(null);
  const requests = useRef(0);
  const stopped = useRef(false);
  const authorityLost = useRef(false);
  const generation = useRef(0);
  const context = useRef({ intentId, initial });
  const abortCurrentRead = useCallback(() => {
    currentController.current?.abort();
    currentController.current = null;
    inFlight.current = false;
  }, []);
  const endContext = useCallback(() => {
    mounted.current = false;
    generation.current++;
    abortCurrentRead();
  }, [abortCurrentRead]);
  const locale = SITE_LANGUAGE_TAGS[language];
  const date = (value: number) =>
    new Intl.DateTimeFormat(locale, {
      dateStyle: 'long',
      timeZone: 'Europe/Zurich',
    }).format(value * 1000);
  const clearPrivateReceipt = useCallback((status: number) => {
    authorityLost.current = true;
    stopped.current = true;
    setAutomatic(false);
    setReceipt(null);
    setRecovering(false);
    setAccepted(false);
    setNotice('');
    setAuthRequired(status === 401);
  }, []);
  useLayoutEffect(() => {
    const previous = context.current;
    context.current = { intentId, initial };
    if (
      previous.intentId === intentId &&
      previous.initial !== null &&
      initial === null
    ) {
      generation.current++;
      abortCurrentRead();
      clearPrivateReceipt(404);
      setBusy(false);
      setError(
        'Le suivi est momentanément indisponible. Réessayez sans créer de nouveau paiement.',
      );
    } else if (
      previous.intentId === intentId &&
      initial !== null &&
      previous.initial !== initial
    ) {
      generation.current++;
      abortCurrentRead();
      setBusy(false);
      setRecovering(false);
      if (!initial.poll) {
        stopped.current = true;
      }
    }
  }, [intentId, initial, abortCurrentRead, clearPrivateReceipt]);
  const refresh = useCallback(
    async (manual = false) => {
      if (
        inFlight.current ||
        !mounted.current ||
        context.current.intentId !== intentId ||
        (!manual &&
          (stopped.current ||
            authorityLost.current ||
            requests.current >= 12 ||
            document.visibilityState !== 'visible'))
      )
        return;
      inFlight.current = true;
      if (!manual && ++requests.current >= 12) {
        stopped.current = true;
        setAutomatic(false);
      }
      const requestGeneration = generation.current;
      const controller = new AbortController();
      currentController.current = controller;
      const isCurrent = () =>
        mounted.current &&
        context.current.intentId === intentId &&
        generation.current === requestGeneration &&
        !controller.signal.aborted;
      const timeout = window.setTimeout(() => controller.abort(), 12000);
      if (manual) {
        setBusy(true);
        setError('');
      }
      try {
        const response = await fetch(
          `/api/payments/postfinance/receipt?achat=${encodeURIComponent(intentId)}`,
          {
            credentials: 'same-origin',
            cache: 'no-store',
            signal: controller.signal,
          },
        );
        if (!isCurrent()) return;
        if (!response.ok) {
          if (
            response.status === 401 ||
            response.status === 403 ||
            response.status === 404
          ) {
            clearPrivateReceipt(response.status);
            throw new Error(
              response.status === 401
                ? 'Reconnectez-vous pour vérifier ce paiement.'
                : 'Ce paiement n’est pas accessible depuis ce compte.',
            );
          }
          throw new Error(
            'Le suivi est momentanément indisponible. Réessayez sans créer de nouveau paiement.',
          );
        }
        const result = (await response.json()) as PrepaidReceipt & {
          code?: string;
        };
        if (!isCurrent()) return;
        if (result.intentId !== intentId) {
          clearPrivateReceipt(404);
          throw new Error('Ce paiement n’est pas accessible depuis ce compte.');
        }
        setReceipt(result);
        setError('');
        setAuthRequired(false);
        if (!result.poll) {
          stopped.current = true;
          setAutomatic(false);
        }
      } catch (failure) {
        if (isCurrent())
          setError(
            failure instanceof Error
              ? failure.message
              : 'Le suivi est momentanément indisponible. Réessayez sans créer de nouveau paiement.',
          );
        else if (
          mounted.current &&
          context.current.intentId === intentId &&
          generation.current === requestGeneration &&
          manual
        )
          setError(
            'La réponse tarde. Vérifiez de nouveau le résultat sans relancer le paiement.',
          );
      } finally {
        window.clearTimeout(timeout);
        if (currentController.current === controller) {
          inFlight.current = false;
          currentController.current = null;
          if (
            mounted.current &&
            context.current.intentId === intentId &&
            generation.current === requestGeneration
          )
            setBusy(false);
        }
      }
    },
    [intentId, clearPrivateReceipt],
  );

  useEffect(() => {
    mounted.current = true;
    generation.current++;
    requests.current = 0;
    authorityLost.current = false;
    const start = context.current.initial;
    stopped.current = start ? !start.poll : false;
    setReceipt(start);
    setError('');
    setNotice('');
    setAccepted(false);
    setAuthRequired(false);
    setBusy(false);
    setRecovering(false);
    setAutomatic(!stopped.current);
    const timer = window.setInterval(() => void refresh(), 5000);
    const visible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', visible);
    const firstRead = !start
      ? window.setTimeout(() => void refresh(), 0)
      : null;
    return () => {
      endContext();
      window.clearInterval(timer);
      if (firstRead !== null) window.clearTimeout(firstRead);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [intentId, refresh, endContext]);

  async function recover() {
    if (
      !canRecover ||
      !receipt ||
      receipt.environment !== 'TEST' ||
      !['pending', 'verification_required'].includes(receipt.status) ||
      busy ||
      recoveryController.current
    )
      return;
    const text = recoveryCopy[language];
    generation.current++;
    abortCurrentRead();
    const requestGeneration = generation.current;
    const controller = new AbortController();
    recoveryController.current = controller;
    currentController.current = controller;
    inFlight.current = true;
    setBusy(true);
    setRecovering(true);
    setError('');
    setNotice('');
    const current = () =>
      mounted.current &&
      context.current.intentId === intentId &&
      generation.current === requestGeneration;
    const timeout = window.setTimeout(() => controller.abort(), 35000);
    let found = false;
    try {
      const response = await fetch('/api/payments/postfinance/recover-create', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseId: intentId }),
      });
      if (!current() || controller.signal.aborted) return;
      if (!response.ok) {
        if ([401, 403, 404].includes(response.status))
          clearPrivateReceipt(response.status);
        throw new Error(
          response.status === 429 ? text.limited : text.unavailable,
        );
      }
      const result: unknown = await response.json();
      if (!current() || controller.signal.aborted) return;
      if (
        !result ||
        typeof result !== 'object' ||
        !('state' in result) ||
        !('receiptHref' in result) ||
        !['tracking', 'verification_required'].includes(String(result.state)) ||
        result.receiptHref !== prepaidReceiptPath(intentId)
      )
        throw new Error(text.unavailable);
      setNotice(
        result.state === 'tracking' ? text.tracking : text.verification,
      );
      found = true;
    } catch (failure) {
      if (current())
        setError(
          controller.signal.aborted
            ? text.timeout
            : failure instanceof Error
              ? failure.message
              : text.unavailable,
        );
    } finally {
      window.clearTimeout(timeout);
      if (recoveryController.current === controller)
        recoveryController.current = null;
      if (currentController.current === controller) {
        currentController.current = null;
        inFlight.current = false;
        if (current()) {
          setBusy(false);
          setRecovering(false);
        }
      }
      if (found && current() && !controller.signal.aborted) await refresh(true);
    }
  }

  async function cancel() {
    if (
      !receipt?.contractId ||
      !receipt.canCancel ||
      !accepted ||
      inFlight.current
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const requestGeneration = generation.current;
    const controller = new AbortController();
    currentController.current = controller;
    const isCurrent = () =>
      mounted.current &&
      context.current.intentId === intentId &&
      generation.current === requestGeneration &&
      !controller.signal.aborted;
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    let confirmed = false;
    try {
      const response = await fetch('/api/payments/postfinance/cancel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contractId: receipt.contractId }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      if (
        response.status === 401 ||
        response.status === 403 ||
        response.status === 404
      ) {
        clearPrivateReceipt(response.status);
        throw new Error(
          response.status === 401
            ? 'Reconnectez-vous pour vérifier ce paiement.'
            : 'Ce paiement n’est pas accessible depuis ce compte.',
        );
      }
      const result = (await response.json()) as {
        cancelled?: boolean;
        error?: string;
      };
      if (!isCurrent()) return;
      if (!response.ok || result.cancelled !== true)
        throw new Error(
          result.error ||
            'L’arrêt du renouvellement doit être vérifié. Réessayez dans quelques instants.',
        );
      if (isCurrent()) {
        setNotice(
          'Le renouvellement est arrêté. Les périodes déjà payées sont conservées.',
        );
        setReceipt({ ...receipt, cancelAtPeriodEnd: true, canCancel: false });
        setAccepted(false);
        confirmed = true;
      }
    } catch (failure) {
      if (
        mounted.current &&
        context.current.intentId === intentId &&
        generation.current === requestGeneration
      )
        setError(
          controller.signal.aborted
            ? 'La réponse tarde. Vérifiez de nouveau le résultat sans relancer le paiement.'
            : failure instanceof Error
              ? failure.message
              : 'L’arrêt du renouvellement doit être vérifié. Réessayez dans quelques instants.',
        );
    } finally {
      window.clearTimeout(timeout);
      if (currentController.current === controller) {
        inFlight.current = false;
        currentController.current = null;
        if (
          mounted.current &&
          context.current.intentId === intentId &&
          generation.current === requestGeneration
        )
          setBusy(false);
      }
      if (
        confirmed &&
        mounted.current &&
        context.current.intentId === intentId &&
        generation.current === requestGeneration
      )
        await refresh(true);
    }
  }

  const state = receipt ? copy[receipt.status] : null;
  const Icon =
    receipt?.status === 'active' || receipt?.status === 'test_confirmed'
      ? CheckCircle2
      : receipt?.poll
        ? Clock3
        : ShieldAlert;
  return (
    <section className="payment-receipt" aria-busy={busy}>
      <Icon size={36} className="payment-receipt-symbol" aria-hidden="true" />
      <h1>{state?.title ?? 'Votre paiement'}</h1>
      {receipt?.environment === 'TEST' && (
        <p className="payment-receipt-message">
          Paiement de test · aucun accès payé
        </p>
      )}
      {state && (
        <output className="payment-receipt-lead">{state.description}</output>
      )}
      {!receipt && !error && <output>Vérification…</output>}
      {receipt && (
        <dl className="payment-receipt-details">
          <div>
            <dt>Formule</dt>
            <dd>{receipt.name}</dd>
          </div>
          <div>
            <dt>{receipt.organization ? 'Entreprise' : 'Espace Support'}</dt>
            <dd>{receipt.organization?.name ?? receipt.workspace?.name}</dd>
          </div>
          <div>
            <dt>Prix mensuel</dt>
            <dd>
              {new Intl.NumberFormat(locale, {
                style: 'currency',
                currency: 'CHF',
              }).format(receipt.priceChfMinor / 100)}
            </dd>
          </div>
          <div>
            <dt>Moyen de paiement</dt>
            <dd>{receipt.method === 'twint' ? 'TWINT' : 'PostFinance Pay'}</dd>
          </div>
          {receipt.purchasedPeriod && (
            <div>
              <dt>Période de cet achat</dt>
              <dd>
                {date(receipt.purchasedPeriod.from)} —{' '}
                {date(receipt.purchasedPeriod.until)}
              </dd>
            </div>
          )}
          {receipt.status === 'active' && receipt.paidUntil && (
            <div>
              <dt>Accès payé jusqu’au</dt>
              <dd>{date(receipt.paidUntil)}</dd>
            </div>
          )}
        </dl>
      )}
      {receipt?.cancelAtPeriodEnd && (
        <p className="payment-receipt-message">Renouvellement arrêté</p>
      )}
      {receipt?.poll && !automatic && (
        <p className="payment-receipt-message">
          La confirmation prend plus de temps. Vous pouvez revenir ici ou
          vérifier de nouveau.
        </p>
      )}
      {notice && <output className="payment-receipt-message">{notice}</output>}
      {error && (
        <p role="alert" className="payment-receipt-error">
          {error}
        </p>
      )}
      <div className="payment-receipt-actions">
        {canRecover &&
          receipt?.environment === 'TEST' &&
          ['pending', 'verification_required'].includes(receipt.status) && (
            <button
              className="account-button secondary"
              disabled={busy}
              onClick={() => void recover()}
            >
              {recovering
                ? recoveryCopy[language].busy
                : recoveryCopy[language].action}
            </button>
          )}
        {receipt && (
          <a className="account-button" href={receipt.subscriptionHref}>
            Voir mon abonnement
          </a>
        )}
        {(!receipt || receipt.poll || error) && (
          <button
            className="account-button secondary"
            disabled={busy}
            onClick={() => void refresh(true)}
          >
            {busy ? 'Vérification…' : 'Vérifier le résultat'}
          </button>
        )}
        {authRequired && (
          <a
            className="account-button secondary"
            href={`/connexion?retour=${encodeURIComponent(prepaidReceiptPath(intentId))}`}
          >
            Se reconnecter
          </a>
        )}
        {!receipt && (
          <a href="/compte" className="payment-receipt-link">
            Retour au compte
          </a>
        )}
      </div>
      {receipt?.canCancel && (
        <details className="payment-receipt-cancel">
          <summary>Arrêter le renouvellement</summary>
          <p>
            Les périodes déjà payées restent disponibles. Un paiement déjà
            envoyé peut encore être traité.
          </p>
          <label>
            <input
              type="checkbox"
              checked={accepted}
              disabled={busy}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>
              Je souhaite arrêter les prochains renouvellements de cet
              abonnement.
            </span>
          </label>
          <button
            className="account-button secondary"
            disabled={busy || !accepted}
            onClick={() => void cancel()}
          >
            Confirmer l’arrêt
          </button>
        </details>
      )}
    </section>
  );
}
