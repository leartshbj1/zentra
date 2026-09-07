import { useCallback, useEffect, useState } from 'react';
import {
  CloudUpload,
  History,
  LoaderCircle,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { desktopApi } from './bridge';
import { CLOUD_BACKUP_CHANGED, type CloudBackupState } from './cloudBackup';
import { Button, Modal, SectionHeading } from './ui';
import { errorMessage, formatDateTime } from './utils';
import './CloudBackupPanel.css';

export function CloudBackupPanel({
  onRestore,
  disabled = false,
  onBusyChange,
  recoveryOnly = false,
}: {
  onRestore: (backupId: string) => Promise<void>;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  recoveryOnly?: boolean;
}) {
  const [state, setState] = useState<CloudBackupState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState<{
    title: string;
    message: string;
    label: string;
    success: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setState(await desktopApi.getCloudBackupState());
    } catch (reason) {
      setError(
        errorMessage(reason, 'Le coffre de sauvegardes est inaccessible.'),
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener(CLOUD_BACKUP_CHANGED, changed);
    return () => window.removeEventListener(CLOUD_BACKUP_CHANGED, changed);
  }, [refresh]);
  useEffect(() => {
    if (!state?.running) return;
    const timer = setTimeout(() => void refresh(), 5_000);
    return () => clearTimeout(timer);
  }, [state, refresh]);
  const busy = disabled || working || Boolean(state?.running);
  async function run(action: () => Promise<unknown>, success: string) {
    setWorking(true);
    onBusyChange?.(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, 'L’opération n’a pas pu être terminée.'));
      await refresh();
    } finally {
      setWorking(false);
      onBusyChange?.(false);
    }
  }
  const backups = state?.backups ?? [];
  return (
    <section
      className="panel settings-card cloud-backup-panel"
      aria-busy={working}
    >
      <SectionHeading
        eyebrow="Récupération"
        title={
          recoveryOnly
            ? 'Retrouver mon entreprise'
            : 'Une copie hors de cet appareil'
        }
        description="Clients, projets, devis, factures, salaires, comptabilité et pièces jointes réunis dans une sauvegarde complète."
        action={
          <Button
            variant="ghost"
            size="small"
            disabled={busy || loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} /> Actualiser
          </Button>
        }
      />
      {loading && !state ? (
        <p role="status">
          <LoaderCircle className="spin" size={16} /> Ouverture du coffre…
        </p>
      ) : null}
      {state?.connected && !recoveryOnly ? (
        <>
          <label className="check-card">
            <input
              type="checkbox"
              checked={state.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                void run(
                  async () => {
                    await desktopApi.setCloudBackupEnabled(enabled);
                    if (enabled) await desktopApi.runCloudBackup(false);
                  },
                  enabled
                    ? 'La copie automatique est activée.'
                    : 'La copie automatique est désactivée.',
                );
              }}
            />
            <span>
              <strong>Sauvegarder automatiquement chaque jour</strong>
              <small>
                Quand Zentra est ouvert et connecté. Un envoi interrompu reprend
                au retour du réseau.
              </small>
            </span>
          </label>
          <div className="cloud-backup-summary">
            <p>
              {state.last_success_at ? (
                <>
                  Dernière copie de cet appareil :{' '}
                  <strong>{formatDateTime(state.last_success_at)}</strong>
                </>
              ) : (
                'Aucune copie distante terminée depuis cet appareil.'
              )}
            </p>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () => desktopApi.runCloudBackup(true),
                  'La sauvegarde complète est conservée dans votre coffre.',
                )
              }
            >
              {busy ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <CloudUpload size={16} />
              )}
              {state.pending_id
                ? 'Reprendre l’envoi'
                : 'Sauvegarder maintenant'}
            </Button>
          </div>
          <p className="settings-copy">
            Le coffre contient les données de toute l’entreprise, y compris les
            salaires. Il est accessible au titulaire et aux administrateurs.
            Jusqu’à 50 copies, 10 Go au total et 512 Mo par copie.
          </p>
        </>
      ) : null}
      {notice ? (
        <p role="status" className="cloud-backup-notice">
          {notice}
        </p>
      ) : null}
      {error || state?.error || state?.last_error ? (
        <p role="alert" className="cloud-backup-error">
          {error || state?.error || state?.last_error}
        </p>
      ) : null}
      {state?.pending_id && !recoveryOnly ? (
        <Button
          variant="ghost"
          size="small"
          disabled={busy}
          onClick={() => {
            setConfirmation({
              title: 'Abandonner cet envoi',
              message:
                'La sauvegarde automatique sera désactivée. Les données de l’entreprise restent sur cet appareil. Une copie incomplète déjà envoyée pourra être supprimée du coffre.',
              label: 'Abandonner l’envoi',
              action: () => desktopApi.cancelCloudBackup(),
              success:
                'L’envoi local est abandonné. Vous pouvez créer une nouvelle sauvegarde.',
            });
          }}
        >
          Abandonner l’envoi en attente
        </Button>
      ) : null}
      {state?.connected ? (
        <>
          <div
            className="cloud-backup-list"
            aria-label="Sauvegardes de l’entreprise"
          >
            {!backups.length ? (
              <p className="settings-copy">
                Aucune sauvegarde dans ce coffre pour le moment.
              </p>
            ) : (
              backups.map((backup) => (
                <article key={backup.backup_id} className="cloud-backup-row">
                  <div className="cloud-backup-row__info">
                    <History size={19} />
                    <div>
                      <strong>{formatDateTime(backup.created_at)}</strong>
                      <small>
                        {(backup.size_bytes / 1024 / 1024).toLocaleString(
                          'fr-CH',
                          { maximumFractionDigits: 1 },
                        )}{' '}
                        Mo · Zentra {backup.app_version} · Appareil …
                        {backup.installation_id.slice(-6)}
                      </small>
                      <span>
                        {backup.state === 'complete'
                          ? 'Copie complète'
                          : backup.state === 'deleting'
                            ? 'Suppression à terminer'
                            : 'Envoi incomplet'}
                      </span>
                    </div>
                  </div>
                  <div className="cloud-backup-row__actions">
                    <Button
                      variant="secondary"
                      size="small"
                      disabled={
                        busy ||
                        backup.state !== 'complete' ||
                        Boolean(state.pending_id)
                      }
                      onClick={() => {
                        setConfirmation({
                          title: 'Restaurer cette sauvegarde',
                          message: `La copie du ${formatDateTime(backup.created_at)} remplacera les données actuelles de cet appareil. Zentra conservera d’abord une copie locale de sécurité.`,
                          label: 'Restaurer cette copie',
                          action: () => onRestore(backup.backup_id),
                          success:
                            'Votre entreprise a été restaurée. La copie de sécurité précédente reste disponible sur cet appareil.',
                        });
                      }}
                    >
                      Restaurer
                    </Button>
                    {!recoveryOnly ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Supprimer la sauvegarde du ${formatDateTime(backup.created_at)}`}
                        title="Supprimer cette copie"
                        disabled={busy}
                        onClick={() => {
                          setConfirmation({
                            title: 'Supprimer cette sauvegarde',
                            message: `La copie du ${formatDateTime(backup.created_at)} sera définitivement retirée du coffre. Conservez au moins une sauvegarde récente vérifiée.`,
                            label: 'Supprimer cette copie',
                            action: () =>
                              desktopApi.deleteCloudBackup(backup.backup_id),
                            success: 'La copie a été supprimée du coffre.',
                          });
                        }}
                      >
                        <Trash2 size={15} />
                      </Button>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>
          {state.pending_id ? (
            <p className="settings-copy">
              Terminez ou supprimez l’envoi incomplet de cet appareil avant de
              restaurer une autre copie.
            </p>
          ) : null}
          {!recoveryOnly ? (
            <p className="settings-copy">
              Restaurer permet de reprendre une ancienne copie sur cet appareil.
              Les modifications réalisées après sa création ne sont pas
              fusionnées.
            </p>
          ) : null}
        </>
      ) : null}
      {confirmation ? (
        <Modal
          title={confirmation.title}
          description={confirmation.message}
          onClose={() => setConfirmation(null)}
        >
          <div className="settings-actions">
            <Button
              variant="secondary"
              data-modal-initial-focus
              onClick={() => setConfirmation(null)}
            >
              Annuler
            </Button>
            <Button
              onClick={() => {
                const next = confirmation;
                setConfirmation(null);
                void run(next.action, next.success);
              }}
            >
              {confirmation.label}
            </Button>
          </div>
        </Modal>
      ) : null}
      <div className="settings-actions">
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void desktopApi
              .openCloudAccountPortal()
              .catch((reason) =>
                setError(
                  errorMessage(reason, 'Le compte web n’a pas pu être ouvert.'),
                ),
              );
          }}
        >
          Retrouver mes copies sur le compte web
        </Button>
      </div>
      <p className="settings-copy">
        Depuis le compte web, le titulaire et les administrateurs peuvent
        télécharger leurs copies même après la fin de l’abonnement.
      </p>
    </section>
  );
}
