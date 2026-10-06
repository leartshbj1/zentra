'use client';
import { useEffect, useRef, useState } from 'react';
import { SITE_LANGUAGE_TAGS, type SiteLanguage } from '@/lib/site-language';
import type { SwissMethod } from '@/lib/payments/postfinance-client';
import type { PrepaidProduct } from '@/lib/payments/prepaid-catalog';
import type { PostFinanceTargets } from '@/lib/payments/postfinance-option';
import {
  originalPurchasePath,
  postFinanceHostedUrl,
} from '@/lib/payments/postfinance-client-navigation';
import {
  prepaidReceiptPath,
  validPrepaidReceiptId,
} from '@/lib/payments/prepaid-receipt-types';
import './postfinance-checkout.css';

type Attempt = {
  requestId: string;
  organizationId?: string;
  workspaceId?: string;
  method: SwissMethod;
  purchaseContext?: string;
};
function readAttemptJournal(
  value: string | null,
): Pick<Attempt, 'requestId' | 'method' | 'purchaseContext'> | null {
  if (!value || value.length > 512) return null;
  const validId = (id: unknown): id is string =>
    typeof id === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
  // Historical UUID-only journals belong to the original PostFinance Pay path.
  // Never reinterpret one as TWINT or discard it to create another request.
  if (validId(value)) return { requestId: value, method: 'postfinance_pay' };
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      ![2, 3].includes(Object.keys(parsed).length) ||
      Object.keys(parsed).some(
        (key) => !['requestId', 'method', 'purchaseContext'].includes(key),
      ) ||
      ('purchaseContext' in parsed &&
        (typeof parsed.purchaseContext !== 'string' ||
          !/^[A-Za-z0-9_-]{43}$/.test(parsed.purchaseContext))) ||
      !('requestId' in parsed) ||
      !('method' in parsed) ||
      !validId(parsed.requestId) ||
      (parsed.method !== 'postfinance_pay' && parsed.method !== 'twint')
    )
      return null;
    return {
      requestId: parsed.requestId,
      method: parsed.method,
      ...('purchaseContext' in parsed
        ? { purchaseContext: parsed.purchaseContext as string }
        : {}),
    };
  } catch {
    return null;
  }
}
const paymentCopy = {
  fr: {
    production:
      'Le paiement sera vérifié avant l’activation de votre abonnement.',
    changed:
      'La configuration du paiement a changé. Vérifiez la tentative déjà lancée.',
    label: 'Moyen de paiement',
    test: 'Essai privé. Aucun accès payé ne sera activé.',
    next: 'Continuer sur',
    unavailable:
      'Cette méthode n’est plus disponible pour cette tentative. Vérifiez le paiement déjà lancé.',
  },
  de: {
    production:
      'Die Zahlung wird vor der Aktivierung Ihres Abonnements geprüft.',
    changed:
      'Die Zahlungseinstellungen haben sich geändert. Prüfen Sie den bereits gestarteten Versuch.',
    label: 'Zahlungsmittel',
    test: 'Privater Test. Es wird kein bezahlter Zugang aktiviert.',
    next: 'Weiter zu',
    unavailable:
      'Dieses Zahlungsmittel ist für diesen Versuch nicht mehr verfügbar. Prüfen Sie die bereits gestartete Zahlung.',
  },
  it: {
    production:
      'Il pagamento verrà verificato prima di attivare il tuo abbonamento.',
    changed:
      'La configurazione del pagamento è cambiata. Verifica il tentativo già avviato.',
    label: 'Metodo di pagamento',
    test: 'Test privato. Non verrà attivato alcun accesso a pagamento.',
    next: 'Continua su',
    unavailable:
      'Questo metodo non è più disponibile per questo tentativo. Verifica il pagamento già avviato.',
  },
  en: {
    production:
      'Payment will be verified before your subscription is activated.',
    changed:
      'The payment setup has changed. Check the attempt already started.',
    label: 'Payment method',
    test: 'Private test. No paid access will be activated.',
    next: 'Continue to',
    unavailable:
      'This method is no longer available for this attempt. Check the payment already started.',
  },
} as const;

export function PostFinanceCheckout({
  ownerId,
  product,
  targets,
  methods,
  testMode,
  purchaseContext,
  initialOrganization,
  initialWorkspace,
  legalVersion,
  consentVersion,
  conditionsHref,
  language = 'fr',
}: {
  ownerId: string;
  product: PrepaidProduct;
  targets: PostFinanceTargets;
  methods: readonly SwissMethod[];
  testMode: boolean;
  purchaseContext: string;
  initialOrganization?: string;
  initialWorkspace?: string;
  legalVersion: string;
  consentVersion?: string;
  conditionsHref: string;
  language?: SiteLanguage;
}) {
  const [method, setMethod] = useState<SwissMethod | ''>(methods[0] ?? '');
  const methodReady = methods.includes(method as SwissMethod);
  const contextReady = /^[A-Za-z0-9_-]{43}$/.test(purchaseContext);
  const text = paymentCopy[language];
  const methodName = method === 'twint' ? 'TWINT' : 'PostFinance Pay';
  const [organization, setOrganization] = useState(
    initialOrganization ??
      (targets.organizations.length === 1 ? targets.organizations[0].id : ''),
  );
  const [workspace, setWorkspace] = useState(
    initialWorkspace ??
      (product.productKind === 'support' && targets.workspaces.length === 1
        ? targets.workspaces[0].id
        : ''),
  );
  const [accepted, setAccepted] = useState(false),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const [attempt, setAttempt] = useState<Attempt | null>(null),
    [receiptHref, setReceiptHref] = useState(''),
    [forbidden, setForbidden] = useState(false);
  const running = useRef(false);
  const selectedWorkspace = targets.workspaces.find(
    (item) => item.id === workspace,
  );
  const selectedOrganization =
    product.productKind === 'support'
      ? (selectedWorkspace?.organizationId ?? undefined)
      : organization || undefined;
  const choices =
    product.productKind === 'complete'
      ? targets.workspaces.filter(
          (item) =>
            (!item.organizationId || item.organizationId === organization) &&
            !targets.workspaces.some(
              (other) =>
                other.organizationId === organization && other.id !== item.id,
            ),
        )
      : targets.workspaces;
  const targetReady =
    (product.productKind === 'support' || !!selectedOrganization) &&
    (!product.support ||
      (!!selectedWorkspace && choices.some((item) => item.id === workspace)));
  const accountHref = selectedOrganization
    ? '/compte/abonnement?organizationId=' +
      encodeURIComponent(selectedOrganization)
    : workspace
      ? '/support/espace?section=subscription&workspace=' +
        encodeURIComponent(workspace)
      : '/compte';
  const format = new Intl.NumberFormat(SITE_LANGUAGE_TAGS[language], {
    style: 'currency',
    currency: 'CHF',
  });
  const binding = JSON.stringify([
    ownerId,
    product.productKey,
    selectedOrganization ?? null,
    product.support ? workspace : null,
    legalVersion,
    consentVersion ?? null,
  ]);
  const storageKey = 'zentra.pf.purchase:' + binding;
  useEffect(() => {
    if (!targetReady || attempt) return;
    let active = true;
    // Load the browser-only journal after hydration, never during server render.
    void Promise.resolve().then(() => {
      if (!active) return;
      try {
        const saved = readAttemptJournal(sessionStorage.getItem(storageKey));
        if (saved) {
          setAttempt({
            ...saved,
            organizationId: selectedOrganization,
            ...(product.support ? { workspaceId: workspace } : {}),
          });
          setMethod(saved.method);
          setMessage(
            saved.purchaseContext !== purchaseContext
              ? text.changed
              : methods.includes(saved.method)
                ? 'Une tentative existe pour cet espace. Vérifiez-la avant de continuer.'
                : text.unavailable,
          );
        }
      } catch {
        /* Storage unavailable: pay refuses dispatch rather than losing the retry identifier. */
      }
    });
    return () => {
      active = false;
    };
  }, [
    storageKey,
    targetReady,
    attempt,
    selectedOrganization,
    product.support,
    workspace,
    methods,
    text.unavailable,
    text.changed,
    purchaseContext,
  ]);

  async function findReceipt(current: Attempt) {
    const params = new URLSearchParams({
      requestId: current.requestId,
      product: product.productKey,
    });
    if (current.organizationId)
      params.set('organizationId', current.organizationId);
    if (current.workspaceId) params.set('workspaceId', current.workspaceId);
    const res = await fetch('/api/payments/postfinance/attempt?' + params, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(12000),
    });
    const data = (await res.json()) as { receiptHref?: string };
    if (res.status === 401 || res.status === 403) {
      setForbidden(true);
      setReceiptHref('');
      return;
    }
    if (res.ok && typeof data.receiptHref === 'string') {
      const url = new URL(data.receiptHref, window.location.origin);
      if (
        url.origin === window.location.origin &&
        url.pathname === '/compte/paiement' &&
        !url.hash &&
        url.searchParams.size === 1 &&
        validPrepaidReceiptId(url.searchParams.get('achat'))
      )
        setReceiptHref(prepaidReceiptPath(url.searchParams.get('achat')));
    }
  }
  async function check() {
    if (!attempt || running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await findReceipt(attempt);
    } catch {
      setMessage(
        'La vérification est momentanément indisponible. Aucun nouveau paiement n’est lancé.',
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function pay(resume = false) {
    if (
      !targetReady ||
      !methodReady ||
      !contextReady ||
      !accepted ||
      (consentVersion && !consent) ||
      (attempt && (!resume || attempt.purchaseContext !== purchaseContext)) ||
      running.current ||
      forbidden ||
      receiptHref
    )
      return;
    running.current = true;
    setBusy(true);
    setMessage('');
    let current: Attempt | null = null;
    try {
      const stored = sessionStorage.getItem(storageKey);
      const saved = readAttemptJournal(stored);
      if (stored && !saved)
        throw Error(
          'Rechargez votre espace pour vérifier la tentative de paiement.',
        );
      current = attempt ?? {
        ...(saved ?? {
          requestId: crypto.randomUUID(),
          method: method as SwissMethod,
          purchaseContext,
        }),
        organizationId: selectedOrganization,
        ...(product.support ? { workspaceId: workspace } : {}),
      };
      setAttempt(current);
      setMethod(current.method);
      if (
        saved &&
        (saved.requestId !== current.requestId ||
          saved.method !== current.method ||
          saved.purchaseContext !== current.purchaseContext)
      )
        throw Error(
          'Rechargez votre espace pour vérifier la tentative de paiement.',
        );
      if (current.purchaseContext !== purchaseContext)
        throw Error(text.changed);
      if (!methods.includes(current.method)) throw Error(text.unavailable);
      if (saved && !attempt)
        throw Error(
          'Une tentative existe pour cet espace. Vérifiez-la avant de continuer.',
        );
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          requestId: current.requestId,
          method: current.method,
          purchaseContext: current.purchaseContext,
        }),
      );
      const res = await fetch('/api/payments/postfinance/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          ...current,
          productKey: product.productKey,
          method: current.method,
          acceptTerms: accepted,
          legalVersion,
          ...(consentVersion ? { consentVersion } : {}),
        }),
      });
      const data = (await res.json()) as {
        url?: string;
        error?: string;
        purchaseId?: string;
        code?: string;
      };
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        setReceiptHref('');
      } else if (validPrepaidReceiptId(data.purchaseId))
        setReceiptHref(prepaidReceiptPath(data.purchaseId));
      if (!res.ok) {
        // Never discard an attempted payment on a validation/configuration
        // refusal: its historical request must remain available for GET checks.
        throw Error(
          data.code === 'configuration_changed'
            ? text.changed
            : data.error ||
                'Votre paiement doit être vérifié avant de continuer.',
        );
      }
      const url = postFinanceHostedUrl(data.url);
      if (!url)
        throw Error(
          'Le lien de paiement doit être vérifié depuis votre abonnement.',
        );
      window.location.assign(url.href);
    } catch (error) {
      setMessage(
        error instanceof Error && error.name === 'Error'
          ? error.message
          : 'La réponse tarde. Vérifiez la tentative sans lancer un autre paiement.',
      );
      if (current)
        try {
          await findReceipt(current);
        } catch {
          /* Keep the same request and offer an explicit read-only check. */
        }
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="postfinance-checkout">
      <h1>Votre abonnement</h1>
      <p className="account-lead">
        {product.name} · {format.format(product.priceChfMinor / 100)} / mois
      </p>
      <p className="postfinance-checkout-test">
        {testMode ? text.test : text.production}
      </p>
      {!forbidden && (
        <>
          <label>
            {text.label}
            <select
              aria-label={text.label}
              value={method}
              disabled={busy || !!attempt || methods.length < 2}
              onChange={(event) => {
                const next = event.target.value;
                if (methods.includes(next as SwissMethod))
                  setMethod(next as SwissMethod);
              }}
            >
              {attempt && !methods.includes(attempt.method) && (
                <option value={attempt.method}>
                  {attempt.method === 'twint' ? 'TWINT' : 'PostFinance Pay'}
                </option>
              )}
              {methods.map((item) => (
                <option key={item} value={item}>
                  {item === 'twint' ? 'TWINT' : 'PostFinance Pay'}
                </option>
              ))}
            </select>
          </label>
          {product.productKind !== 'support' && (
            <label>
              Votre entreprise
              <select
                value={organization}
                disabled={busy || !!attempt}
                onChange={(event) => {
                  setOrganization(event.target.value);
                  setWorkspace('');
                }}
              >
                <option value="">Choisissez votre entreprise.</option>
                {targets.organizations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {product.support && (
            <label>
              Votre espace Support
              <select
                value={workspace}
                disabled={
                  busy ||
                  !!attempt ||
                  (product.productKind === 'complete' && !organization)
                }
                onChange={(event) => setWorkspace(event.target.value)}
              >
                <option value="">Choisissez votre espace Support.</option>
                {choices.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {product.productKind === 'support' &&
            selectedWorkspace?.organizationId && (
              <p>
                {
                  targets.organizations.find(
                    (item) => item.id === selectedWorkspace.organizationId,
                  )?.name
                }
              </p>
            )}
          {product.productKind !== 'support' &&
            !targets.organizations.length && (
              <a className="account-button secondary" href="/compte">
                Créer mon entreprise
              </a>
            )}
          {product.support && !choices.length && (
            <a
              className="account-button secondary"
              href="/support/espace?section=connections"
            >
              Préparer mon espace Support
            </a>
          )}
          <div className="postfinance-checkout-consent">
            <label>
              <input
                type="checkbox"
                checked={accepted}
                disabled={busy || !!receiptHref}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              <span>
                J’accepte les{' '}
                <a href={conditionsHref} target="_blank" rel="noreferrer">
                  conditions de l’abonnement
                </a>{' '}
                et son renouvellement mensuel.
              </span>
            </label>
            {consentVersion && (
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  disabled={busy || !!receiptHref}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                <span>
                  J’autorise le traitement des extraits nécessaires aux
                  suggestions d’Automation.
                </span>
              </label>
            )}
          </div>
          {!attempt && (
            <button
              className="account-button"
              disabled={
                busy ||
                !targetReady ||
                !methodReady ||
                !contextReady ||
                !accepted ||
                (!!consentVersion && !consent)
              }
              onClick={() => void pay()}
            >
              {busy ? 'Un instant…' : `${text.next} ${methodName}`}
            </button>
          )}
        </>
      )}
      {message && (
        <p role="alert" className="postfinance-checkout-message">
          {message}
        </p>
      )}
      {forbidden && (
        <p>
          Reconnectez-vous au compte propriétaire pour retrouver ce paiement.
        </p>
      )}
      {attempt && !forbidden && (
        <div className="postfinance-checkout-actions">
          {receiptHref ? (
            <a className="account-button" href={receiptHref}>
              Suivre ce paiement
            </a>
          ) : (
            <>
              <button
                className="account-button secondary"
                disabled={busy}
                onClick={() => void check()}
              >
                Vérifier la tentative
              </button>
              <button
                className="account-button secondary"
                disabled={
                  busy ||
                  !targetReady ||
                  !methodReady ||
                  !contextReady ||
                  attempt.purchaseContext !== purchaseContext ||
                  !accepted ||
                  (!!consentVersion && !consent)
                }
                onClick={() => void pay(true)}
              >
                Reprendre le même paiement
              </button>
            </>
          )}
          <a href={accountHref}>Mon abonnement</a>
        </div>
      )}
      {!attempt && (
        <a
          className="postfinance-checkout-back"
          href={originalPurchasePath(
            product.productKey,
            selectedOrganization,
            workspace,
          )}
        >
          Continuer par carte ou TWINT
        </a>
      )}
    </section>
  );
}
