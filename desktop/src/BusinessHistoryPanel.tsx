import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  CloudDownload,
  CloudUpload,
  LoaderCircle,
  Pause,
  RefreshCw,
} from 'lucide-react';
import { desktopApi } from './bridge';
import {
  BUSINESS_HISTORY_CHANGED,
  BUSINESS_HISTORY_STATUS,
  BUSINESS_HISTORY_ERROR,
  type BusinessHistoryState,
} from './businessHistoryState';
import type { BusinessBootstrapStatus } from './businessBootstrapScheduler';
import { Button, Modal, SectionHeading } from './ui';
import { errorMessage } from './utils';
import './BusinessHistoryPanel.css';

export function BusinessHistoryPanel({
  joinOnly = false,
  disabled = false,
  onBusyChange,
  onImport,
}: {
  joinOnly?: boolean;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onImport?: (transferId: string) => Promise<void>;
}) {
  const [state, setState] = useState<BusinessHistoryState | null>(null);
  const [progress, setProgress] = useState<BusinessBootstrapStatus | null>(
    null,
  );
  const [working, setWorking] = useState(false);
  const [receiving, setReceiving] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [confirmation, setConfirmation] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const stopped = useRef(false);
  const revision = useRef(0);
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const next = await desktopApi.getBusinessHistoryState();
      if (request === revision.current) setState(next);
    } catch (reason) {
      if (request === revision.current)
        setError(
          errorMessage(reason, 'Le partage est momentanément inaccessible.'),
        );
    }
  }, []);
  useEffect(() => {
    stopped.current = false;
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const status = (event: Event) => {
      const next = (event as CustomEvent<BusinessBootstrapStatus>).detail;
      setProgress(next);
      setError('');
      if (['history_installed', 'not_prepared'].includes(next.state))
        void refresh();
    };
    const wake = () => void refresh();
    const failed = (event: Event) =>
      setError((event as CustomEvent<string>).detail);
    window.addEventListener(BUSINESS_HISTORY_STATUS, status);
    window.addEventListener(BUSINESS_HISTORY_ERROR, failed);
    window.addEventListener('online', wake);
    window.addEventListener('focus', wake);
    return () => {
      stopped.current = true;
      window.clearTimeout(initialRefresh);
      invalidate();
      window.removeEventListener(BUSINESS_HISTORY_STATUS, status);
      window.removeEventListener(BUSINESS_HISTORY_ERROR, failed);
      window.removeEventListener('online', wake);
      window.removeEventListener('focus', wake);
    };
  }, [refresh, invalidate]);
  useEffect(() => {
    if (!state?.publication_pending || working) return;
    const timer = window.setTimeout(() => void refresh(), 20_000);
    return () => window.clearTimeout(timer);
  }, [state, working, refresh]);
  async function run(action: () => Promise<unknown>) {
    setWorking(true);
    onBusyChange?.(true);
    setError('');
    setNotice('');
    try {
      await action();
      await refresh();
    } catch (reason) {
      setError(
        errorMessage(
          reason,
          'L’opération a été interrompue. Les données locales sont conservées.',
        ),
      );
    } finally {
      setWorking(false);
      onBusyChange?.(false);
    }
  }
  async function receive() {
    stopped.current = false;
    setReceiving(true);
    try {
      while (!stopped.current) {
        if (navigator.onLine === false)
          throw new Error(
            'Connexion interrompue. Les éléments déjà reçus sont conservés ; reprenez dès le retour du réseau.',
          );
        const next = await desktopApi.receiveBusinessHistory();
        if (stopped.current) break;
        if (next.state === 'history_received' && next.transfer_id) {
          setInstalling(true);
          setNotice('Vérification et installation du dossier…');
          await onImport?.(next.transfer_id);
          setNotice('Le dossier est installé sur cet appareil.');
          return;
        }
        if (next.state === 'uninitialized')
          throw new Error(
            'Le dossier n’a pas encore été publié depuis le premier appareil.',
          );
        setNotice(
          'Réception des données et documents en cours. Une coupure pourra être reprise.',
        );
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      setNotice(
        'Réception suspendue. Les éléments déjà vérifiés restent disponibles pour la reprise.',
      );
    } finally {
      setReceiving(false);
      setInstalling(false);
    }
  }
  const busy = disabled || working;
  const pending = Boolean(state?.publication_pending);
  const statusText =
    progress?.state === 'history_checking' || state?.state === 'checking'
      ? 'Vérification du dossier et de la comptabilité…'
      : state?.state === 'publishing'
        ? 'Confirmation de la copie partagée…'
        : progress?.state === 'files_uploading'
          ? 'Envoi des documents…'
          : 'Envoi de la première copie…';
  return (
    <section
      className="panel settings-card business-history-panel"
      aria-busy={working}
    >
      <SectionHeading
        eyebrow="Dossier d’entreprise"
        title={
          joinOnly
            ? 'Retrouver le dossier partagé'
            : 'Une première copie pour vos appareils'
        }
        description="Clients, projets, devis, factures, banque, paie, comptabilité et documents."
        action={
          <Button
            variant="ghost"
            size="small"
            disabled={busy}
            onClick={() => void refresh()}
          >
            <RefreshCw size={15} /> Actualiser
          </Button>
        }
      />
      {!state && !error ? (
        <output className="business-history-notice">
          <LoaderCircle className="spin" size={16} /> Recherche du dossier…
        </output>
      ) : null}
      {state?.connected === false ? (
        <p>
          Connectez votre compte Zentra pour retrouver le dossier de votre
          entreprise.
        </p>
      ) : null}
      {state?.connected ? (
        <>
          {state.state === 'installed' ? (
            <div className="business-history-status">
              <Check size={22} />
              <div>
                <strong>La copie initiale est installée</strong>
                <p>
                  Les nouvelles modifications restent sur cet appareil. Les
                  échanges continus entre appareils sont encore en préparation.
                </p>
              </div>
            </div>
          ) : state.state === 'needs_reconciliation' ? (
            <p>
              Ce profil contient un dossier déjà lié. Une réconciliation est
              nécessaire pour le partager à nouveau ; vos données sont
              conservées.
            </p>
          ) : pending ? (
            <div className="business-history-status" aria-live="polite">
              <LoaderCircle className="spin" size={22} />
              <div>
                <strong>{statusText}</strong>
                <p>
                  Vous pouvez consulter vos données. Les modifications sont
                  suspendues jusqu’à la confirmation ou l’annulation de cette
                  première publication.
                </p>
              </div>
            </div>
          ) : state.has_remote_history ? (
            <p>
              {state.can_import
                ? 'Le dossier de votre entreprise est disponible. Il sera vérifié avant son installation sur cet appareil.'
                : 'Un dossier partagé existe déjà. Retrouvez-le sur un profil neuf : les données présentes sur cet appareil ne seront pas remplacées.'}
            </p>
          ) : (
            <p>
              {joinOnly
                ? 'La première copie doit être publiée depuis l’appareil qui contient le dossier complet.'
                : state.can_publish
                  ? 'Choisissez cet appareil comme point de départ si son dossier contient toutes vos données à partager.'
                  : 'Le titulaire ou un administrateur peut publier la première copie depuis l’appareil qui contient le dossier complet.'}
            </p>
          )}
          {state.state !== 'installed' &&
          state.state !== 'needs_reconciliation' ? (
            <>
              <p className="business-history-scope">
                Cette étape reprend la copie initiale. Elle n’échange pas encore
                les modifications suivantes entre appareils.
              </p>
              <div className="business-history-actions">
                {!joinOnly &&
                state.can_publish &&
                !state.has_remote_history &&
                !pending ? (
                  <Button disabled={busy} onClick={() => setConfirmation(true)}>
                    <CloudUpload size={17} /> Publier la première copie
                  </Button>
                ) : null}
                {!joinOnly && state.can_publish && pending ? (
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setProgress(await desktopApi.syncBusinessBootstrap());
                        window.dispatchEvent(
                          new Event(BUSINESS_HISTORY_CHANGED),
                        );
                      })
                    }
                  >
                    <RefreshCw size={17} /> Reprendre l’envoi
                  </Button>
                ) : null}
                {!joinOnly &&
                state.can_publish &&
                (pending || state.state === 'prepared') ? (
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const result =
                          await desktopApi.cancelBusinessPublication();
                        setProgress(null);
                        setNotice(
                          result.state === 'history_installed'
                            ? 'La publication était déjà confirmée. La copie est disponible.'
                            : 'La préparation est annulée. Vous pouvez modifier votre dossier.',
                        );
                        window.dispatchEvent(
                          new Event(BUSINESS_HISTORY_CHANGED),
                        );
                      })
                    }
                  >
                    Annuler la préparation
                  </Button>
                ) : null}
                {state.can_import &&
                state.has_remote_history &&
                onImport &&
                !receiving ? (
                  <Button disabled={busy} onClick={() => void run(receive)}>
                    <CloudDownload size={17} /> Retrouver ce dossier
                  </Button>
                ) : null}
                {receiving ? (
                  <Button
                    variant="ghost"
                    disabled={installing}
                    onClick={() => {
                      stopped.current = true;
                    }}
                  >
                    <Pause size={17} /> Suspendre la réception
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </>
      ) : null}
      {notice ? (
        <output className="business-history-notice">{notice}</output>
      ) : null}
      {error ? (
        <p className="business-history-error" role="alert">
          {error}
        </p>
      ) : null}
      {confirmation ? (
        <Modal
          title="Publier le dossier de cet appareil"
          onClose={() => setConfirmation(false)}
          description="Cette copie devient le point de départ des autres appareils de votre entreprise."
        >
          <p>
            Vérifiez que ce dossier est complet. Ses documents et ses données, y
            compris la paie, seront accessibles aux collaborateurs autorisés du
            compte connecté.
          </p>
          <p>
            Les modifications seront suspendues pendant la première publication.
            Vous pourrez reprendre l’envoi après une coupure, ou annuler tant
            que la publication n’est pas confirmée.
          </p>
          <div className="form-actions">
            <Button variant="ghost" onClick={() => setConfirmation(false)}>
              Retour
            </Button>
            <Button
              onClick={() => {
                setConfirmation(false);
                void run(async () => {
                  setProgress(await desktopApi.startBusinessPublication());
                  window.dispatchEvent(new Event(BUSINESS_HISTORY_CHANGED));
                });
              }}
            >
              Publier ce dossier
            </Button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
