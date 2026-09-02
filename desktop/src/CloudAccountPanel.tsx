import { useEffect, useRef, useState } from 'react';
import {
  Check,
  Cloud,
  Copy,
  ExternalLink,
  LoaderCircle,
  LockKeyhole,
  Users,
} from 'lucide-react';
import { desktopApi, type CloudAccountState } from './bridge';
import { errorMessage, formatDateTime } from './utils';
import { Button, SectionHeading } from './ui';

const ROLE_LABEL: Record<NonNullable<CloudAccountState['role']>, string> = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  accountant: 'Comptable / fiduciaire',
  member: 'Collaborateur',
  read_only: 'Lecture seule',
};

export function CloudAccountPanel({
  onAccountChange,
}: {
  onAccountChange?: (account: CloudAccountState) => void;
}) {
  const [account, setAccount] = useState<CloudAccountState | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const pollInFlight = useRef(false);

  useEffect(() => {
    let active = true;
    desktopApi
      .getCloudAccountState()
      .then((value) => {
        if (active) {
          setAccount(value);
          onAccountChange?.(value);
        }
      })
      .catch((reason) => {
        if (active)
          setError(
            errorMessage(reason, 'Le compte Zentra n’a pas pu être lu.'),
          );
      });
    return () => {
      active = false;
    };
  }, [onAccountChange]);

  useEffect(() => {
    if (account?.status !== 'pending') return;
    const interval = window.setInterval(
      () => void poll(false),
      Math.max(3, account.intervalSeconds ?? 3) * 1_000,
    );
    return () => window.clearInterval(interval);
  }, [account?.status, account?.intervalSeconds]);

  async function begin() {
    setBusy(true);
    setError('');
    try {
      const pending = await desktopApi.startCloudAccountLink();
      setAccount(pending);
      onAccountChange?.(pending);
      await desktopApi.openCloudAccountLink();
    } catch (reason) {
      setError(
        errorMessage(reason, 'La connexion au compte n’a pas pu démarrer.'),
      );
    } finally {
      setBusy(false);
    }
  }

  async function poll(showError = true) {
    if (pollInFlight.current) return;
    pollInFlight.current = true;
    if (showError) setBusy(true);
    try {
      const next = await desktopApi.pollCloudAccountLink();
      setAccount(next);
      onAccountChange?.(next);
      setError('');
    } catch (reason) {
      if (showError) {
        setError(
          errorMessage(reason, 'L’autorisation n’a pas pu être vérifiée.'),
        );
      }
    } finally {
      pollInFlight.current = false;
      if (showError) setBusy(false);
    }
  }

  async function disconnect() {
    if (
      !window.confirm(
        'Déconnecter ce poste du compte Zentra ? Les données locales ne seront pas supprimées.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      await desktopApi.disconnectCloudAccount();
      const disconnected: CloudAccountState = { status: 'disconnected' };
      setAccount(disconnected);
      onAccountChange?.(disconnected);
    } catch (reason) {
      setError(errorMessage(reason, 'Ce poste n’a pas pu être déconnecté.'));
    } finally {
      setBusy(false);
    }
  }

  async function copyCode() {
    if (!account?.userCode) return;
    try {
      await navigator.clipboard.writeText(account.userCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setError(
        'Le code n’a pas pu être copié. Vous pouvez le saisir manuellement.',
      );
    }
  }

  const connected = account?.status === 'connected';
  const expired = account?.status === 'expired';
  const inactive = account?.status === 'inactive';
  const pending = account?.status === 'pending';
  const currentStep = connected ? 3 : pending ? 2 : 1;

  return (
    <section className="panel settings-card settings-card--wide">
      <SectionHeading
        eyebrow="Compte, équipe & fiduciaire"
        title="Compte Zentra sécurisé"
        description="Reliez l’abonnement, invitez votre équipe ou votre fiduciaire et utilisez le coffre de factures. Les données de travail restent d’abord dans ce profil local."
      />

      <ol
        className="settings-cloud-steps"
        aria-label="Étapes de connexion au compte"
      >
        {[
          ['Relier ce poste', 'Zentra ouvre la page sécurisée.'],
          ['Confirmer le code', 'Comparez le même code dans le navigateur.'],
          ['Gérer les accès', 'Invitez sans supplément équipe et fiduciaire.'],
        ].map(([title, description], index) => {
          const step = index + 1;
          const done =
            step < currentStep || (connected && step === currentStep);
          return (
            <li
              key={title}
              className={`${done ? 'is-done' : ''} ${step === currentStep ? 'is-current' : ''}`}
              aria-current={step === currentStep ? 'step' : undefined}
            >
              <span>{done ? <Check size={15} /> : step}</span>
              <div>
                <strong>{title}</strong>
                <small>{description}</small>
              </div>
            </li>
          );
        })}
      </ol>

      {!account ? (
        <div className="settings-cloud-status">
          <LoaderCircle className="spin" size={20} />
          <span>Lecture du compte protégé…</span>
        </div>
      ) : connected ? (
        <div className="settings-cloud-account is-connected">
          <span className="settings-cloud-account__icon">
            <Check size={22} />
          </span>
          <div>
            <strong>{account.organizationName}</strong>
            <p>
              {account.role ? ROLE_LABEL[account.role] : 'Membre'} · session de
              ce poste valable jusqu’au{' '}
              {account.sessionExpiresAt
                ? formatDateTime(account.sessionExpiresAt)
                : 'renouvellement'}
            </p>
          </div>
        </div>
      ) : pending ? (
        <div className="settings-cloud-link">
          <div className="settings-cloud-link__code">
            <span>Code à vérifier</span>
            <strong>{account.userCode}</strong>
          </div>
          <p>
            Le navigateur doit confirmer ce même code. Zentra vérifie ensuite
            automatiquement l’autorisation, sans recevoir votre mot de passe.
          </p>
          <div className="settings-actions">
            <Button
              variant="secondary"
              onClick={() => void desktopApi.openCloudAccountLink()}
            >
              <ExternalLink size={16} /> Ouvrir la page sécurisée
            </Button>
            <Button variant="secondary" onClick={() => void copyCode()}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Code copié' : 'Copier le code'}
            </Button>
            <Button disabled={busy} onClick={() => void poll(true)}>
              {busy ? <LoaderCircle className="spin" size={16} /> : null}
              Vérifier maintenant
            </Button>
          </div>
        </div>
      ) : (
        <div className="settings-cloud-intro">
          <div>
            {expired || inactive ? (
              <LockKeyhole size={24} />
            ) : (
              <Cloud size={24} />
            )}
            <strong>
              {inactive
                ? 'Abonnement à réactiver'
                : expired
                  ? 'Session du poste expirée'
                  : 'Aucun compte relié'}
            </strong>
            <p>
              {inactive
                ? 'Les données locales restent lisibles. Réactivez l’abonnement puis reliez de nouveau ce poste pour modifier et archiver.'
                : expired
                  ? 'Reconnectez ce poste pour reprendre les fonctions d’équipe et l’archivage.'
                  : 'Reliez ce poste à l’entreprise pour utiliser les accès partagés et l’archive distante.'}
            </p>
          </div>
          <Button disabled={busy} onClick={() => void begin()}>
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Users size={16} />
            )}
            {busy ? 'Préparation…' : 'Relier ce poste'}
          </Button>
        </div>
      )}

      <div className="settings-cloud-privacy">
        <LockKeyhole size={17} />
        <p>
          Le jeton de session est chiffré par Windows DPAPI ou stocké dans le
          Trousseau macOS. Le serveur ne conserve que son empreinte, jamais le
          secret utilisable.
        </p>
      </div>
      <p className="settings-cloud-scope">
        Les rôles encadrent les services connectés. « Lecture seule » bloque
        aussi les modifications dans cette interface. Les dossiers métier
        restent locaux et ne sont pas synchronisés en temps réel entre les
        appareils.
      </p>
      {connected ? (
        <div className="settings-actions">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void desktopApi.openCloudAccountPortal()}
          >
            <ExternalLink size={16} /> Gérer l’équipe, la fiduciaire et les
            appareils
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => void disconnect()}
          >
            Déconnecter ce poste
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
