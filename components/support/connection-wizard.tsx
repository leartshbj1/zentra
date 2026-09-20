'use client';
import { useState } from 'react';
import { ArrowLeft, ArrowUpRight, Check, Link2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Field } from './controls';
import { PROVIDERS, type SupportState, type Mutate } from './model';

export function ConnectionWizard({
  open,
  onOpenChange,
  data,
  mutate,
  busy,
  demo,
  error,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  data: SupportState;
  mutate: Mutate;
  busy: boolean;
  demo: boolean;
  error?: string;
  onConnected: (result: Record<string, unknown>) => void;
}) {
  const [step, setStep] = useState(1),
    [provider, setProvider] = useState('infomaniak'),
    [domain, setDomain] = useState(''),
    [key, setKey] = useState('');
  const waiting =
    provider === 'gorgias' ||
    (provider === 'zendesk' && !data.zendesk?.ready && !data.platformOwner);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent className="support-dialog support-connect-wizard">
        <DialogHeader>
          <DialogTitle>
            {step === 1
              ? 'Que souhaitez-vous connecter ?'
              : `Connecter ${PROVIDERS[provider as keyof typeof PROVIDERS]}`}
          </DialogTitle>
          <DialogDescription>
            {step === 1
              ? 'Choisissez votre outil. Nous vous guidons pour la suite.'
              : provider === 'infomaniak'
                ? 'Les nouveaux mails seront classés dans Zentra Support. Votre boîte Infomaniak reste inchangée.'
                : 'Votre mot de passe reste chez votre éditeur. Zentra vérifie les équipes disponibles.'}
          </DialogDescription>
        </DialogHeader>
        <ol className="support-wizard-steps" aria-label="Étapes de connexion">
          <li aria-current={step === 1 ? 'step' : undefined}>
            1 · Votre connexion
          </li>
          <li aria-current={step === 2 ? 'step' : undefined}>
            2 · Autorisation
          </li>
          <li>3 · Réception des tickets</li>
        </ol>
        {step === 1 ? (
          <>
            <div className="support-provider-grid">
              {Object.entries(PROVIDERS).map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={provider === id}
                  onClick={() => {
                    setProvider(id);
                    setDomain('');
                    setKey('');
                  }}
                >
                  <span className="support-provider-icon">
                    {id === 'api' ? <Link2 size={22} /> : name[0]}
                  </span>
                  <strong>{name}</strong>
                  <small>
                    {id === 'infomaniak'
                      ? 'Votre boîte mail, directement'
                      : id === 'zendesk'
                        ? data.zendesk?.ready
                          ? 'Autorisation en un clic'
                          : 'En préparation'
                        : id === 'gorgias'
                          ? 'Bientôt disponible'
                          : id === 'api'
                            ? 'Pour votre équipe technique'
                            : 'Installation guidée'}
                  </small>
                  {provider === id && <Check size={17} />}
                </button>
              ))}
            </div>
            <Button className="support-primary" onClick={() => setStep(2)}>
              Continuer
            </Button>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (waiting || demo) return;
              const result = await mutate(
                provider === 'infomaniak'
                  ? { action: 'connectMailbox', email: domain, apiKey: key }
                  : provider === 'zendesk'
                    ? { action: 'startZendesk', domain }
                    : {
                        action: 'connect',
                        provider,
                        domain,
                        apiKey: key,
                        label:
                          provider === 'api' ? 'Mon outil de support' : domain,
                      },
              );
              if (!result) return;
              if (typeof result.url === 'string') {
                window.location.assign(result.url);
                return;
              }
              setKey('');
              onConnected(result);
              onOpenChange(false);
            }}
          >
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(1)}
              disabled={busy}
            >
              <ArrowLeft size={16} />
              Changer de logiciel
            </Button>
            {error && (
              <p role="alert" className="support-notice support-error">
                {error}
              </p>
            )}
            {waiting ? (
              <div className="support-notice">
                <strong>Cette connexion n’est pas encore ouverte.</strong>
                <p>
                  {provider === 'zendesk'
                    ? 'Nous préparons l’autorisation officielle avec Zendesk.'
                    : 'L’intégration Gorgias sera proposée après validation par son éditeur.'}{' '}
                  N’achetez pas d’abonnement pour cet outil tant que sa
                  connexion n’est pas disponible.
                </p>
              </div>
            ) : (
              <>
                {provider !== 'api' && provider !== 'infomaniak' && (
                  <Field
                    label="Adresse de votre logiciel"
                    placeholder={`https://votre-entreprise.${provider}.com`}
                    value={domain}
                    onChange={(e) => setDomain(e.target.value)}
                    required
                    maxLength={500}
                    autoComplete="url"
                  />
                )}
                {provider === 'infomaniak' && (
                  <>
                    <Field
                      label="Adresse de votre boîte mail"
                      type="email"
                      placeholder="contact@votre-entreprise.ch"
                      value={domain}
                      onChange={(e) => setDomain(e.target.value)}
                      required
                      maxLength={254}
                      autoComplete="email"
                    />
                    <div className="support-guided-help">
                      <strong>Autoriser Zentra à lire vos mails</strong>
                      <ol>
                        <li>Ouvrez les clés API de votre compte Infomaniak.</li>
                        <li>
                          Créez une clé dédiée à Zentra Support avec le droit{' '}
                          <code>workspace:mail</code>.
                        </li>
                        <li>
                          Copiez cette clé ci-dessous. Vous pourrez la révoquer
                          à tout moment chez Infomaniak.
                        </li>
                      </ol>
                      <a
                        href="https://manager.infomaniak.com/v3/ng/accounts/token"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Ouvrir Infomaniak <ArrowUpRight size={14} />
                      </a>
                    </div>
                    <Field
                      label="Clé de connexion Infomaniak"
                      type="password"
                      autoComplete="new-password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      required
                      maxLength={8192}
                    />
                    <p className="support-small">
                      La clé est chiffrée côté serveur. Seuls les mails reçus à
                      partir de la connexion sont récupérés, même lorsque cette
                      page est fermée. Le texte est analysé par le service de
                      tri de Zentra ; les pièces jointes ne sont pas importées.
                      Aucun mail n’est envoyé, déplacé ou supprimé.
                    </p>
                  </>
                )}
                {provider === 'freshdesk' && (
                  <>
                    <div className="support-guided-help">
                      <strong>Où trouver votre clé Freshdesk ?</strong>
                      <ol>
                        <li>
                          Ouvrez Freshdesk avec votre compte administrateur.
                        </li>
                        <li>
                          Cliquez sur votre photo de profil, puis sur les
                          paramètres du profil.
                        </li>
                        <li>Copiez votre clé API et collez-la ci-dessous.</li>
                      </ol>
                      <a
                        href="https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Voir le guide Freshdesk <ArrowUpRight size={14} />
                      </a>
                    </div>
                    <Field
                      label="Clé de connexion Freshdesk"
                      type="password"
                      autoComplete="new-password"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      required
                      maxLength={8192}
                    />
                    <p className="support-small">
                      Elle sert à lire vos tickets et vos équipes, puis à
                      appliquer l’affectation et la priorité. Elle est chiffrée
                      sur le serveur.
                    </p>
                  </>
                )}
                {provider === 'zendesk' && (
                  <p className="support-small">
                    Vous serez redirigé vers Zendesk pour autoriser Zentra.
                    Aucun mot de passe ni clé à copier.{' '}
                    {data.platformOwner && !data.zendesk?.ready && (
                      <>
                        Essai privé limité à votre compte développeur.{' '}
                        <a href="/support/admin">
                          Configurer l’application Zendesk
                        </a>
                        .
                      </>
                    )}
                  </p>
                )}
                {provider === 'api' && (
                  <div className="support-guided-help">
                    <strong>Une connexion sur mesure</strong>
                    <p>
                      Votre équipe technique configure Make, n8n ou votre outil
                      pour envoyer les tickets et appliquer les décisions. Le
                      guide et les informations à copier s’afficheront à l’étape
                      suivante.
                    </p>
                  </div>
                )}
                <Button
                  type="submit"
                  className="support-primary"
                  disabled={busy || demo}
                >
                  {busy
                    ? 'Vérification en cours…'
                    : provider === 'zendesk'
                      ? 'Autoriser dans Zendesk'
                      : provider === 'api'
                        ? 'Préparer ma connexion'
                        : 'Vérifier et continuer'}
                </Button>
              </>
            )}
            {demo && (
              <p className="support-small">
                <a href="/support/espace">
                  Créer mon espace pour connecter mon logiciel
                </a>
              </p>
            )}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
