'use client';
import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_THRESHOLDS,
  type Feature,
  type Mode,
} from '@/lib/automation/types';
import { FEATURE_LABELS } from './labels';
async function api(path: string, org: string, body?: Record<string, unknown>) {
  const res = await fetch(
    body ? path : `${path}?organizationId=${encodeURIComponent(org)}`,
    body
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, organizationId: org }),
          signal: AbortSignal.timeout(25000),
        }
      : { cache: 'no-store',signal: AbortSignal.timeout(25000) },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      typeof data.error === 'string'
        ? data.error
        : 'Réessayez dans un instant.',
    );
  return data;
}
type Settings = {
  revision?: number;
  enabled: boolean;
  mode: Mode;
  flags: Feature[];
  thresholds: { medium: number; high: number };
  consent: boolean;
};
type State = {
  activity?: {date:string;totals:{analyzed:number;suggestions:number;confirmed:number;needsReview:number};features:{feature:Feature;analyzed:number;confirmed:number}[]} | null;
  settings: Settings;
  available: Feature[];
  active: boolean;
  canManage: boolean;
};
type Billing = {
  offeredAccess?: boolean;
  offeredUntil?: number | null;
  ready: boolean;
  status: string;
  hasSubscription: boolean;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
};
// Keep client constants free from server/secret imports.
const consentVersion = 'automation-2026-09-20';
export function AutomationCompanySettings({
  organizations,
  initialOrganization = '',
  paymentReturned = false,
}: {
  initialOrganization?: string;
  paymentReturned?: boolean;
  organizations: {
    organizationId: string;
    organizationName: string;
    role: string;
  }[];
}) {
  const pending=useRef(false);
  const [org, setOrg] = useState(
      organizations.some((o) => o.organizationId === initialOrganization)
        ? initialOrganization
        : organizations[0]?.organizationId || '',
    ),
    [state, setState] = useState<State | null>(null),
    [billing, setBilling] = useState<Billing | null>(null),
    [settings, setSettings] = useState<Settings>({
      enabled: false,
      mode: 'shadow',
      flags: [],
      thresholds: DEFAULT_THRESHOLDS,
      consent: false,
    }),
    [consent, setConsent] = useState(false),
    [terms, setTerms] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, organizationId: org }),
      signal: AbortSignal.timeout(25000),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok)
      throw new Error(
        typeof data.error === 'string'
          ? data.error
          : 'Réessayez dans un instant.',
      );
    return data;
  }
  async function load() {
    const res = await fetch(
      `/api/automation?organizationId=${encodeURIComponent(org)}`,
      { cache: 'no-store',signal: AbortSignal.timeout(25000) },
    );
    const data = (await res.json()) as State & { error?: string };
    if (!res.ok) throw new Error(data.error || 'Réessayez.');
    return data;
  }
  useEffect(() => {
    let live = true;
    setState(null);setBilling(null);setConsent(false);setTerms(false);setMessage('');
    if (!org) return;
    // Team access never depends on loading the owner's billing controls.
    api('/api/automation', org)
      .then((data) => {
        const s = data as State;
        if (live) {
          setState(s);
          setSettings(s.settings);
          setConsent(s.settings.consent);
        }
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      });
    if (organizations.find((o) => o.organizationId === org)?.role === 'owner') {
      api('/api/automation/billing', org, {
        action:
          paymentReturned && org === initialOrganization ? 'refresh' : 'state',
      })
        .then(async (b) => {
          if (!live) return;
          setBilling(b as unknown as Billing);
          if (paymentReturned) {
            const s = (await api('/api/automation', org)) as State;
            if (live) {
              setState(s);
              setSettings(s.settings);
              setConsent(s.settings.consent);
            }
          }
        })
        .catch((e) => {
          if (live) setMessage(e.message);
        });
    }
    return () => {
      live = false;
    };
  }, [org, initialOrganization, paymentReturned]);
  async function action(which: 'save' | 'checkout' | 'portal' | 'refresh') {
    if(pending.current)return;
    pending.current=true;
    setBusy(true);
    setMessage('');
    try {
      if (which === 'save') {
        const data = await post('/api/automation', {
          action: 'settings',
          ...settings,
          ...(consent ? { consentVersion } : {}),
        });
        setSettings(data as unknown as Settings);
        setMessage('Réglages enregistrés.');
      } else {
        const data = await post('/api/automation/billing', {
          action: which,
          acceptTerms: terms,
          legalVersion: consentVersion,
          consentVersion: consent ? consentVersion : undefined,
        });
        if (typeof data.url === 'string') {
          const url = new URL(data.url);
          if (
            url.protocol !== 'https:' ||
            !['checkout.stripe.com', 'billing.stripe.com'].includes(
              url.hostname,
            )
          )
            throw new Error('Page de paiement non reconnue.');
          window.location.assign(url.href);
        } else {
          setBilling(data as unknown as Billing);
          const s = await load();
          setState(s);
          setMessage(
            s.active
              ? 'Votre option est active. Choisissez les fonctions ci-dessous.'
              : 'Le paiement est encore en cours de confirmation.',
          );
        }
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Réessayez.');
    } finally {
      pending.current=false;
      setBusy(false);
    }
  }
  if (!organizations.length)
    return (
      <section className="automation-panel">
        <h2>Reliez d’abord votre entreprise</h2>
        <p>
          Automation est une option de Zentra Gestion. Créez ou rejoignez votre
          entreprise pour retrouver ses réglages ici.
        </p>
        <a className="automation-button" href="/compte">
          Mon entreprise
        </a>
      </section>
    );
  return (
    <section className="automation-panel">
      {state?.active&&<p><a href={`/compte/automation/reception?entreprise=${encodeURIComponent(org)}`}>Voir les factures reçues dans Gestion →</a></p>}
      <label htmlFor="automation-company">Entreprise</label>
      <select
        id="automation-company"
        value={org}
        disabled={busy}
        onChange={(e) => {
          setOrg(e.target.value);
          setState(null);
          setBilling(null);
          setMessage('');
        }}
      >
        {organizations.map((o) => (
          <option key={o.organizationId} value={o.organizationId}>
            {o.organizationName}
          </option>
        ))}
      </select>
      {!state && !message && <p role="status">Chargement des réglages…</p>}
      <h2>
        {state?.active
          ? 'Votre option est active'
          : 'Simplifiez les tâches répétitives'}
      </h2>
      {state?.active && (
        <p>
          <strong>Disponible pour toute votre équipe.</strong> Chaque
          collaborateur connecté à cette entreprise retrouve Automation dans
          Zentra Gestion, avec ses droits habituels. Aucune activation
          individuelle.
        </p>
      )}
      {billing?.offeredAccess &&
      billing.offeredUntil &&
      !billing.hasSubscription ? (
        <output>
          Accès offert jusqu’au{' '}
          {new Date(billing.offeredUntil * 1000).toLocaleDateString('fr-CH')}.
          Aucun paiement demandé.
        </output>
      ) : state && !state.active ? (
        <div className="automation-price">
          15 CHF <small>/ mois par entreprise</small>
        </div>
      ) : null}
      <p>
        En complément de Zentra Gestion. Les écritures, paiements et
        suppressions restent soumis à votre validation.
      </p>
      {state &&
        !state.active &&
        !billing?.hasSubscription &&
        organizations.find((o) => o.organizationId === org)?.role ===
          'owner' && (
          <>
            <div className="automation-checks">
              <label>
                <input
                  type="checkbox"
                  checked={terms}
                  onChange={(e) => setTerms(e.target.checked)}
                />
                <span>
                  J’accepte les{' '}
                  <a
                    href="/automation/conditions"
                    target="_blank"
                    rel="noreferrer"
                  >
                    conditions de l’option
                  </a>
                  .
                </span>
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                <span>
                  J’autorise le traitement des extraits nécessaires aux
                  suggestions, décrit dans les{' '}
                  <a
                    href="/automation/conditions"
                    target="_blank"
                    rel="noreferrer"
                  >
                    conditions
                  </a>
                  .
                </span>
              </label>
            </div>
            <button
              disabled={
                busy ||
                !terms ||
                !consent ||
                !billing?.ready ||
                organizations.find((o) => o.organizationId === org)?.role !==
                  'owner'
              }
              onClick={() => void action('checkout')}
            >
              Activer · 15 CHF/mois
            </button>
            {!billing?.ready && (
              <p>
                Le paiement de cette option est en cours de préparation. Aucun
                montant n’est prélevé.
              </p>
            )}
          </>
        )}
      {billing?.hasSubscription &&
        organizations.find((o) => o.organizationId === org)?.role ===
          'owner' && (
          <div className="automation-actions">
            <button
              disabled={
                busy ||
                organizations.find((o) => o.organizationId === org)?.role !==
                  'owner'
              }
              onClick={() => void action('portal')}
            >
              Gérer mon abonnement
            </button>
            {billing.cancelAtPeriodEnd && billing.periodEnd && (
              <p>
                Fin de l’option le{' '}
                {new Date(billing.periodEnd * 1000).toLocaleDateString('fr-CH')}
                .
              </p>
            )}
          </div>
        )}
      {state &&
        !state.active &&
        organizations.find((o) => o.organizationId === org)?.role !==
          'owner' && (
          <p>
            Le titulaire peut activer Automation une seule fois pour toute
            l’entreprise.
          </p>
        )}
      {state &&
        organizations.find((o) => o.organizationId === org)?.role ===
          'owner' && (
          <button
            style={{ marginTop: '1rem' }}
            disabled={busy}
            onClick={() => void action('refresh')}
          >
            Vérifier mon activation
          </button>
        )}
      {state?.active && !state.canManage && (
        <p>
          Les réglages sont partagés avec votre équipe. Le titulaire ou un
          administrateur peut les modifier.
        </p>
      )}
      {state?.active && state.activity && <section className="account-card automation-daily" aria-label="Activité du jour"><h2>Aujourd’hui, dans votre entreprise</h2><dl className="automation-metrics"><div><dt>Analyses</dt><dd>{state.activity.totals.analyzed}</dd></div><div><dt>À vérifier</dt><dd>{state.activity.totals.needsReview}</dd></div><div><dt>Validées par l’équipe</dt><dd>{state.activity.totals.confirmed}</dd></div></dl>{!state.activity.totals.analyzed && <p>Les analyses apparaîtront ici dès que vous utiliserez Automation dans Zentra Gestion.</p>}<p className="account-caption">Bilan du jour, heure suisse. Une suggestion n’est comptée comme validée qu’après confirmation par un utilisateur.</p></section>}
      {state?.active && state.canManage && (
        <fieldset disabled={busy || !state.canManage}>
          <legend>Comment souhaitez-vous utiliser Automation ?</legend>
          <div className="automation-checks">
            <label>
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) =>
                  setSettings({ ...settings, enabled: e.target.checked })
                }
              />
              Activer les suggestions
            </label>
          </div>
          <label htmlFor="automation-mode">Mode</label>
          <select
            id="automation-mode"
            value={settings.mode}
            onChange={(e) =>
              setSettings({ ...settings, mode: e.target.value as Mode })
            }
          >
            <option value="shadow">
              Observation · vos choix restent inchangés
            </option>
            <option value="suggest">
              Suggestions · vous vérifiez et confirmez
            </option>
          </select>
          <div className="automation-checks">
            {state.available.map((f) => (
              <label key={f}>
                <input
                  type="checkbox"
                  checked={settings.flags.includes(f)}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      flags: e.target.checked
                        ? [...settings.flags, f]
                        : settings.flags.filter((v) => v !== f),
                    })
                  }
                />
                {FEATURE_LABELS[f]}
              </label>
            ))}
          </div>
          {!state.available.length && (
            <p>
              Les fonctions seront disponibles après leur activation par Zentra.
            </p>
          )}
          <details>
            <summary>Seuils de confiance</summary>
            <label>
              Suggestion à partir de (%)
              <input
                type="number"
                min="50"
                max="99"
                value={Math.round(settings.thresholds.medium * 100)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    thresholds: {
                      ...settings.thresholds,
                      medium: Number(e.target.value) / 100,
                    },
                  })
                }
              />
            </label>
            <label>
              Confiance élevée à partir de (%)
              <input
                type="number"
                min="51"
                max="100"
                value={Math.round(settings.thresholds.high * 100)}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    thresholds: {
                      ...settings.thresholds,
                      high: Number(e.target.value) / 100,
                    },
                  })
                }
              />
            </label>
          </details>
          {!settings.consent && (
            <div className="automation-checks">
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(e) => setConsent(e.target.checked)}
                />
                J’autorise le traitement des extraits nécessaires aux
                suggestions. <a href="/automation/conditions">En savoir plus</a>
              </label>
            </div>
          )}
          <button type="button" onClick={() => void action('save')}>
            Enregistrer
          </button>
        </fieldset>
      )}
      <output aria-live="polite">{message}</output>
    </section>
  );
}
