'use client';
import { useEffect, useRef, useState } from 'react';
import { SITE_LANGUAGE_TAGS, type SiteLanguage } from '@/lib/site-language';
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
};
export function PostFinanceCheckout({
  ownerId,
  product,
  targets,
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
  initialOrganization?: string;
  initialWorkspace?: string;
  legalVersion: string;
  consentVersion?: string;
  conditionsHref: string;
  language?: SiteLanguage;
}) {
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
        const saved = sessionStorage.getItem(storageKey);
        if (
          saved &&
          /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            saved,
          )
        ) {
          setAttempt({
            requestId: saved,
            organizationId: selectedOrganization,
            ...(product.support ? { workspaceId: workspace } : {}),
          });
          setMessage(
            'Une tentative existe pour cet espace. Vérifiez-la avant de continuer.',
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
      !accepted ||
      (consentVersion && !consent) ||
      (attempt && !resume) ||
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
      const requestId = attempt?.requestId ?? stored ?? crypto.randomUUID();
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          requestId,
        )
      )
        throw Error(
          'Rechargez votre espace pour vérifier la tentative de paiement.',
        );
      sessionStorage.setItem(storageKey, requestId);
      current = attempt ?? {
        requestId,
        organizationId: selectedOrganization,
        ...(product.support ? { workspaceId: workspace } : {}),
      };
      setAttempt(current);
      const res = await fetch('/api/payments/postfinance/checkout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(25000),
        body: JSON.stringify({
          ...current,
          productKey: product.productKey,
          method: 'postfinance_pay',
          acceptTerms: accepted,
          legalVersion,
          ...(consentVersion ? { consentVersion } : {}),
        }),
      });
      const data = (await res.json()) as {
        url?: string;
        error?: string;
        purchaseId?: string;
      };
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        setReceiptHref('');
      } else if (validPrepaidReceiptId(data.purchaseId))
        setReceiptHref(prepaidReceiptPath(data.purchaseId));
      if (!res.ok) {
        if (res.status === 400) {
          sessionStorage.removeItem(storageKey);
          setAttempt(null);
        }
        throw Error(
          data.error || 'Votre paiement doit être vérifié avant de continuer.',
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
        Essai privé PostFinance Pay. Aucun accès payé ne sera activé.
      </p>
      {!forbidden && (
        <>
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
                !accepted ||
                (!!consentVersion && !consent)
              }
              onClick={() => void pay()}
            >
              {busy ? 'Un instant…' : 'Continuer sur PostFinance Pay'}
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
