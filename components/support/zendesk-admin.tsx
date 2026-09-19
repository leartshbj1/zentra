'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field } from './controls';
export function ZendeskAdmin({
  status,
  onSaved,
}: {
  status?: {
    configured?: boolean;
    ready: boolean;
    developerDomain?: string;
    redirectUri?: string;
    scopes?: string;
  };
  onSaved: () => Promise<void>;
}) {
  const [clientId, setClientId] = useState(''),
    [secret, setSecret] = useState(''),
    [domain, setDomain] = useState(status?.developerDomain || ''),
    [approved, setApproved] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  return (
    <section className="support-admin-validation">
      <h2>Connexion officielle Zendesk</h2>
      <p>
        {status?.ready
          ? 'Ouverte aux clients.'
          : status?.configured
            ? 'Configurée pour les essais privés. La validation globale reste nécessaire.'
            : 'À configurer dans votre compte développeur Zendesk.'}
      </p>
      <details>
        <summary>Configurer l’application Zendesk</summary>
        <p>
          Dans Zendesk Admin Center → Applications et intégrations → API Zendesk
          → Clients OAuth, créez un client Zentra avec un identifiant commençant
          par zdg-. L’accès des clients ne doit être ouvert qu’après approbation
          du client global par Zendesk.
        </p>
        <p>Adresse de retour :</p>
        <code className="support-break">{status?.redirectUri}</code>
        <p>
          Autorisations : <code>{status?.scopes}</code>
        </p>
        <p>
          <a
            href="https://developer.zendesk.com/documentation/marketplace/building-a-marketplace-app/set-up-a-global-oauth-client/"
            target="_blank"
            rel="noreferrer"
          >
            Guide officiel de validation Zendesk ↗
          </a>
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              const response = await fetch('/api/support', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'configureZendesk',
                  clientId,
                  clientSecret: secret,
                  developerDomain: domain,
                  approved,
                }),
              });
              const data = (await response.json()) as { error?: string };
              if (!response.ok)
                throw new Error(data.error || 'Configuration impossible.');
              setSecret('');
              setMessage(
                approved
                  ? 'Configuration enregistrée. Vérifiez le parcours complet avant de proposer cette connexion à vos clients.'
                  : 'Configuration privée enregistrée. Testez la connexion depuis votre espace propriétaire.',
              );
              await onSaved();
            } catch (error) {
              setMessage(
                error instanceof Error
                  ? error.message
                  : 'Connexion impossible.',
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field
            label="Domaine du compte développeur"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="d3v-votrecompte.zendesk.com"
            required
          />
          <Field
            label="Identifiant du client OAuth"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="zdg-zentra-support"
            required
          />
          <Field
            label="Secret du client OAuth"
            type="password"
            autoComplete="new-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
          />
          <label className="support-terms">
            <input
              type="checkbox"
              checked={approved}
              onChange={(e) => setApproved(e.target.checked)}
            />
            <span>
              Zendesk a confirmé l’approbation de mon client OAuth global.
              Ouvrir la connexion aux clients.
            </span>
          </label>
          <Button type="submit" disabled={busy}>
            {busy ? 'Enregistrement…' : 'Enregistrer la configuration'}
          </Button>
        </form>
      </details>
      {message && <output>{message}</output>}
    </section>
  );
}
