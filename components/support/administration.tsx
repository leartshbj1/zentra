'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Field } from './controls';
import type { CalibrationReport } from '@/lib/support/calibration';

export function SupportAdministration() {
  const [status, setStatus] = useState<{
    ready: boolean;
    verifiedAt: number | null;
    calibration: CalibrationReport | null;
  } | null>(null);
  const [access, setAccess] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false),
    [token, setToken] = useState(''),
    [checking, setChecking] = useState(false);
  const load = useCallback(async () => {
    try {
      let response = await fetch('/api/support?admin=1', { cache: 'no-store' });
      if (response.status === 401) {
        const refreshed = await fetch('/api/auth/session', {
          cache: 'no-store',
        });
        if (refreshed.ok)
          response = await fetch('/api/support?admin=1', { cache: 'no-store' });
      }
      setAccess(response.status);
      const data = (await response.json()) as {
        ready: boolean;
        verifiedAt: number | null;
        calibration: CalibrationReport | null;
        error?: string;
      };
      if (response.status === 401 || response.status === 403) {
        setStatus(null);
        setError('');
        return;
      }
      if (!response.ok)
        throw new Error(
          data.error || 'Impossible de charger l’administration.',
        );
      setStatus(data);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Vérifiez votre connexion.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <div className="support-app">
      <header className="support-topbar">
        <a href="/support">
          <BrandWordmark className="support-wordmark" />
        </a>
        <span className="support-product">Administration Support</span>
      </header>
      <main className="support-welcome">
        <ShieldCheck size={32} />
        <p className="support-eyebrow">ESPACE PROPRIÉTAIRE</p>
        <h1>L’analyse, pour tous vos clients.</h1>
        {error && (
          <p className="support-notice support-error" role="alert">
            {error}
          </p>
        )}
        {access === 401 || access === 403 ? (
          <>
            <p>
              Collez votre jeton administrateur pour ouvrir cet espace privé.
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                try {
                  const response = await fetch('/api/support/admin/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                  });
                  const result = (await response.json()) as { error?: string };
                  if (!response.ok)
                    throw new Error(result.error || 'Accès refusé.');
                  setToken('');
                  await load();
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : 'Connexion impossible.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field
                label="Jeton administrateur"
                type="password"
                autoComplete="current-password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                maxLength={100}
                required
              />
              <Button
                className="support-primary"
                type="submit"
                disabled={busy || !token.trim()}
              >
                {busy ? 'Ouverture…' : 'Ouvrir l’administration'}
              </Button>
            </form>
            <p className="support-small">
              L’accès reste ouvert pendant 8 heures dans ce navigateur.
            </p>
            <a href="/connexion?retour=%2Fsupport%2Fadmin">
              Ou utiliser mon compte propriétaire
            </a>
          </>
        ) : !access && !error ? (
          <p>Vérification de votre accès…</p>
        ) : null}
        {status && (
          <>
            <p>
              Une seule clé pour Zentra Support. Vos clients connectent leur
              logiciel de support ; l’analyse est fournie par Zentra.
            </p>
            <p className="support-notice">
              {status.ready
                ? 'L’analyse est configurée.'
                : 'L’analyse attend votre clé.'}
              {status.verifiedAt
                ? ` Dernière vérification : ${new Date(status.verifiedAt * 1000).toLocaleString('fr-CH')}.`
                : ''}
            </p>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                setError('');
                setMessage('');
                try {
                  const response = await fetch('/api/support', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                      action: 'platformKey',
                      apiKey: key,
                    }),
                  });
                  const result = (await response.json()) as { error?: string };
                  if (!response.ok)
                    throw new Error(
                      result.error || 'La clé n’a pas pu être enregistrée.',
                    );
                  setKey('');
                  setMessage(
                    'Clé vérifiée sur un exemple et activée pour les espaces clients.',
                  );
                  await load();
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Enregistrement impossible.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Field
                label={
                  status.ready
                    ? 'Remplacer la clé IA de Zentra'
                    : 'Clé IA de Zentra'
                }
                type="password"
                autoComplete="new-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                maxLength={8192}
                required
              />
              <p className="support-small">
                Stockée chiffrée sur le serveur. Elle n’est jamais affichée aux
                clients. La vérification effectue une analyse d’un texte fictif.{' '}
                Utilisez une clé de votre{' '}
                <a
                  href="https://console.typesafe.ai/keys"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  console TypeSafe
                </a>
                , distincte de votre jeton administrateur.
              </p>
              <Button
                className="support-primary"
                type="submit"
                disabled={busy || checking || !key.trim()}
              >
                {busy ? 'Vérification…' : 'Vérifier et activer pour Zentra'}
              </Button>
            </form>
            {message && <p role="status">{message}</p>}
            <section className="support-admin-validation">
              <h2>Vérifier la qualité du tri</h2>
              <p>
                12 exemples fictifs : facturation, panne, remboursement, quatre
                langues et demandes ambiguës. Le test appelle réellement le
                service d’analyse et ne modifie aucun ticket client.
              </p>
              <Button
                variant="outline"
                disabled={busy || checking || !status.ready}
                onClick={async () => {
                  setChecking(true);
                  setError('');
                  try {
                    const response = await fetch('/api/support', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ action: 'validateTriage' }),
                    });
                    const result = (await response.json()) as {
                      error?: string;
                      report?: CalibrationReport;
                    };
                    if (!response.ok || !result.report)
                      throw new Error(
                        result.error || 'Vérification impossible.',
                      );
                    const report = result.report;
                    setStatus((previous) =>
                      previous
                        ? { ...previous, calibration: report }
                        : previous,
                    );
                  } catch (e) {
                    setError(
                      e instanceof Error
                        ? e.message
                        : 'Vérification impossible.',
                    );
                  } finally {
                    setChecking(false);
                  }
                }}
              >
                {checking
                  ? 'Analyse des 12 exemples…'
                  : 'Tester la configuration'}
              </Button>
              {status.calibration && (
                <div className="support-calibration" aria-live="polite">
                  <h3>
                    {status.calibration.passed} / {status.calibration.total}{' '}
                    exemples conformes
                  </h3>
                  <p className="support-small">
                    Vérifié le{' '}
                    {new Date(
                      status.calibration.testedAt * 1000,
                    ).toLocaleString('fr-CH')}
                    . Ces exemples ne garantissent pas les résultats sur tous
                    les tickets réels.
                  </p>
                  <ul>
                    {status.calibration.results.map((row) => (
                      <li key={row.id}>
                        <strong>
                          {row.passed ? '✓' : 'À examiner'} · {row.label}
                        </strong>
                        <span>
                          {row.observed}
                          {row.confidence === null
                            ? ''
                            : ` · confiance ${Math.round(row.confidence * 100)} %`}
                        </span>
                        {!row.passed && <small>Attendu : {row.expected}</small>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
            <Button
              variant="ghost"
              disabled={busy || checking}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const response = await fetch('/api/support/admin/session', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ logout: true }),
                  });
                  if (!response.ok)
                    throw new Error('Impossible de fermer la session.');
                  setStatus(null);
                  setAccess(401);
                  setKey('');
                  setToken('');
                  setMessage('');
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : 'Impossible de fermer la session.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Fermer l’accès par jeton
            </Button>
          </>
        )}
        <a href="/support/espace">
          <ArrowLeft size={16} /> Revenir à mon espace
        </a>
      </main>
    </div>
  );
}
