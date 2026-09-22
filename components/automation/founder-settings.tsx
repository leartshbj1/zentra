'use client';
import { useEffect, useState } from 'react';
import { FEATURES, type Feature } from '@/lib/automation/types';
export const FEATURE_LABELS: Record<Feature, string> = {
  transaction_classification: 'Opérations bancaires',
  document_routing: 'Documents',
  supplier_routing: 'Factures fournisseurs',
  agent_routing: 'Assistant Zentra',
  anomaly_detection: 'Opérations inhabituelles',
  priority: 'Priorités',
  email_classification: 'E-mails importés',
  import_mapping: 'Import de données',
};
type State = {
  configured: boolean;
  billingReady?: boolean;
  flags: Feature[];
  metrics: Record<string, number | null> | null;
};
export function AutomationFounderSettings() {
  const [state, setState] = useState<State | null>(null),
    [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [flags, setFlags] = useState<Feature[]>([]);
  async function send(body: Record<string, unknown>) {
    const response = await fetch('/api/automation/admin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await response.json()) as State & { error?: string };
    if (!response.ok)
      throw new Error(data.error || 'Réessayez dans un instant.');
    return data;
  }
  useEffect(() => {
    let live = true;
    send({ action: 'state' })
      .then((data) => {
        if (live) {
          setState(data);
          setFlags(data.flags);
        }
      })
      .catch((e) => {
        if (live) setMessage(e.message);
      });
    return () => {
      live = false;
    };
  }, []);
  async function save(action: 'key' | 'flags' | 'billing' | 'test') {
    setBusy(true);
    setMessage('');
    try {
      await send(
        action === 'key' ? { action, apiKey: key } : { action, flags },
      );
      if (action === 'key') setKey('');
      const data = await send({ action: 'state' });
      setState(data);
      setFlags(data.flags);
      setMessage(
        action === 'test'
          ? 'Service vérifié avec une opération fictive.'
          : action === 'key'
            ? 'Clé vérifiée et enregistrée sur le serveur.'
            : action === 'billing'
              ? 'Tarif de 15 CHF/mois vérifié et prêt dans Stripe.'
              : 'Fonctions disponibles mises à jour.',
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Réessayez.');
    } finally {
      setBusy(false);
    }
  }
  const m = state?.metrics,
    reviewed = m?.reviewed || 0;
  return (
    <section className="automation-panel">
      <p className="automation-eyebrow">Compte fondateur</p>
      <h2>Réglages du service</h2>
      <p>
        Ces réglages sont visibles uniquement par le fondateur. La clé est
        commune à Automation et Support ; elle reste chiffrée sur le serveur.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save('key');
        }}
      >
        <label htmlFor="automation-key">
          Clé API TypeSafe Jev {state?.configured ? '· configurée' : ''}
        </label>
        <input
          id="automation-key"
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="Coller une nouvelle clé"
        />
        <button disabled={busy || !key.trim()} type="submit">
          Vérifier et enregistrer
        </button>
      </form>
      <button
        type="button"
        disabled={busy || !state?.configured}
        onClick={() => void save('test')}
      >
        Vérifier le service
      </button>
      <fieldset disabled={busy || !state}>
        <legend>Abonnement de l’option</legend>
        <p>
          15 CHF par mois et par entreprise. Cette préparation ne prélève aucun
          client.
        </p>
        <button type="button" onClick={() => void save('billing')}>
          {state?.billingReady
            ? 'Vérifier le tarif et les notifications Stripe'
            : 'Préparer le tarif de 15 CHF/mois'}
        </button>
      </fieldset>
      <fieldset disabled={busy || !state}>
        <legend>Fonctions disponibles</legend>
        <p>
          Chaque entreprise choisit ensuite ses fonctions et son mode. Aucun
          réglage ici ne déclenche d’opération comptable.
        </p>
        <div className="automation-checks">
          {FEATURES.map((f) => (
            <label key={f}>
              <input
                type="checkbox"
                checked={flags.includes(f)}
                onChange={(e) =>
                  setFlags((old) =>
                    e.target.checked ? [...old, f] : old.filter((v) => v !== f),
                  )
                }
              />
              {FEATURE_LABELS[f]}
            </label>
          ))}
        </div>
        <button type="button" onClick={() => void save('flags')}>
          Enregistrer les fonctions
        </button>
      </fieldset>
      <output aria-live="polite">{message}</output>
      {m && (
        <>
          <h3>Observation · 30 derniers jours</h3>
          <dl className="automation-metrics">
            <div>
              <dt>Analyses</dt>
              <dd>{m.volume || 0}</dd>
            </div>
            <div>
              <dt>Acceptées</dt>
              <dd>
                {reviewed
                  ? `${Math.round(((m.accepted || 0) / reviewed) * 100)} %`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Corrigées</dt>
              <dd>
                {reviewed
                  ? `${Math.round(((m.corrected || 0) / reviewed) * 100)} %`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Latence moyenne</dt>
              <dd>
                {m.averageLatencyMs !== null
                  ? `${Math.round(m.averageLatencyMs || 0)} ms`
                  : '—'}
              </dd>
            </div>
            <div>
              <dt>Erreurs</dt>
              <dd>{m.errors || 0}</dd>
            </div>
          </dl>
          <p>
            Accord avec les choix évalués par les utilisateurs ; ce taux n’est
            pas une garantie de précision sur toutes les opérations.
          </p>
        </>
      )}
    </section>
  );
}
