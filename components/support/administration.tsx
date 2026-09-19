'use client';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import { BrandWordmark } from '@/components/brand-mark';
import { Button } from '@/components/ui/button';
import { Field } from './controls';

export function SupportAdministration() {
  const [status, setStatus] = useState<{
    ready: boolean;
    verifiedAt: number | null;
  } | null>(null);
  const [access, setAccess] = useState(0),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const [key, setKey] = useState(''),
    [busy, setBusy] = useState(false);
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
        error?: string;
      };
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
        {access === 401 ? (
          <a
            className="support-admin-login"
            href="/connexion?retour=%2Fsupport%2Fadmin"
          >
            Se connecter au compte propriétaire
          </a>
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
                clients. La vérification effectue une analyse d’un texte fictif.
              </p>
              <Button
                className="support-primary"
                type="submit"
                disabled={busy || !key.trim()}
              >
                {busy ? 'Vérification…' : 'Vérifier et activer pour Zentra'}
              </Button>
            </form>
            {message && <p role="status">{message}</p>}
          </>
        )}
        <a href="/support/espace">
          <ArrowLeft size={16} /> Revenir à mon espace
        </a>
      </main>
    </div>
  );
}
