import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { archivesWithoutCopy, copiesToRecover, type LegalArchive, type VaultCopy } from './legalArchive';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage } from './utils';

/**
 * Second support de l'archive légale : une copie chiffrée sur cet appareil,
 * gardée dans le coffre en ligne de Zentra. Sans la clé de récupération,
 * personne ne peut la lire, pas même Zentra.
 */
export function LegalArchiveVault({ archives, readOnly }: { archives: readonly LegalArchive[]; readOnly: boolean }) {
  useAppLanguage();
  const [copies, setCopies] = useState<VaultCopy[] | null>(null);
  const [localKeyId, setLocalKeyId] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState('');
  const [code, setCode] = useState<{ value: string; fresh: boolean } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [entered, setEntered] = useState<Record<string, string>>({});
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let live = true;
    desktopApi
      .listLegalArchiveCopies()
      .then((result) => { if (live) { setCopies(result.copies); setLocalKeyId(result.localKeyId); setUnavailable(''); } })
      .catch((reason) => { if (live) setUnavailable(errorMessage(reason, t('Le coffre n’a pas pu être consulté.'))); });
    return () => { live = false; };
  }, [reload]);
  async function copy(archiveId: string) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await desktopApi.copyLegalArchiveToVault(archiveId);
      setMessage(t('Copie chiffrée de l’archive {year} conservée dans le coffre.', { year: result.year }));
      setPending(null);
      setCode(null);
      setReload((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason, t('La copie n’a pas pu être envoyée. Réessayez : les blocs déjà reçus sont gardés.')));
    } finally {
      setBusy(false);
    }
  }
  async function start(archiveId: string) {
    if (localKeyId) return copy(archiveId);
    // Première copie : la clé est créée et montrée avant tout envoi.
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.legalArchiveRecoveryCode();
      setCode({ value: result.code, fresh: result.created });
      setLocalKeyId(result.keyId);
      setPending(archiveId);
    } catch (reason) {
      setError(errorMessage(reason, t('La clé de récupération n’a pas pu être préparée.')));
    } finally {
      setBusy(false);
    }
  }
  async function showCode() {
    setError('');
    try {
      const result = await desktopApi.legalArchiveRecoveryCode();
      setCode({ value: result.code, fresh: result.created });
      setLocalKeyId(result.keyId);
    } catch (reason) {
      setError(errorMessage(reason, t('La clé de récupération n’a pas pu être lue.')));
    }
  }
  async function recover(copyItem: VaultCopy) {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await desktopApi.restoreLegalArchiveCopy(copyItem, copyItem.keyId === localKeyId ? undefined : entered[copyItem.copyId]);
      if (result) setMessage(t('Archive {year} récupérée et vérifiée : {path}', { year: copyItem.year, path: result.path }));
      setReload((value) => value + 1);
    } catch (reason) {
      setError(errorMessage(reason, t('L’archive n’a pas pu être récupérée.')));
    } finally {
      setBusy(false);
    }
  }
  const toCopy = copies ? archivesWithoutCopy(archives, copies) : [];
  const toRecover = copies ? copiesToRecover(archives, copies) : [];
  const stored = copies?.filter((item) => item.completedAt !== null && !toRecover.includes(item)) ?? [];
  return (
    <div className="legal-vault">
      <h3>{t('Second support chiffré')}</h3>
      <p>{t('Zentra garde une copie de chaque archive dans son coffre en ligne. Elle est chiffrée sur cet appareil : sans votre clé de récupération, personne ne peut la lire, pas même Zentra.')}</p>
      {unavailable ? <p>{unavailable}</p> : null}
      {error ? <ErrorPanel message={error} /> : null}
      {message ? <p role="status">{message}</p> : null}
      {code ? (
        <div className="legal-vault__code" role="group" aria-labelledby="legal-vault-code-title">
          <strong id="legal-vault-code-title">{t('Votre clé de récupération')}</strong>
          <code>{code.value}</code>
          <p>{t('Notez-la ou gardez-la dans votre gestionnaire de mots de passe. Elle permet de relire les copies depuis un autre appareil. Zentra ne la connaît pas et ne peut pas la retrouver.')}</p>
          <div className="erp-register__actions">
            {pending ? <Button disabled={busy || readOnly} onClick={() => void copy(pending)}>{busy ? t('Envoi…') : t('J’ai noté la clé, copier l’archive')}</Button> : null}
            <Button variant="secondary" disabled={busy} onClick={() => { setCode(null); setPending(null); }}>{t('Masquer la clé')}</Button>
          </div>
        </div>
      ) : null}
      {copies ? (
        <ul className="erp-register__list" aria-label={t('Copies chiffrées')}>
          {stored.map((item) => (
            <li key={item.copyId}><span><strong>{t('Année {year} · copie chiffrée', { year: item.year })}</strong><small>{item.fileName}</small></span></li>
          ))}
          {toCopy.map((archive) => (
            <li key={archive.id}>
              <span><strong>{t('Année {year} · pas encore copiée', { year: archive.year })}</strong><small>{archive.fileName}</small></span>
              <Button variant="secondary" size="small" disabled={busy || readOnly || Boolean(code && pending)} onClick={() => void start(archive.id)}>{t('Copier dans le coffre')}</Button>
            </li>
          ))}
          {toRecover.map((item) => (
            <li key={item.copyId} className="legal-vault__recover">
              <span><strong>{t('Année {year} · absente de cet appareil', { year: item.year })}</strong><small>{item.fileName}</small></span>
              {item.keyId !== localKeyId ? (
                <Field label={t('Clé de récupération')}>
                  <input value={entered[item.copyId] ?? ''} autoComplete="off" spellCheck={false} onChange={(event) => setEntered((current) => ({ ...current, [item.copyId]: event.target.value }))} />
                </Field>
              ) : null}
              <Button variant="secondary" size="small" disabled={busy || (item.keyId !== localKeyId && !(entered[item.copyId] ?? '').trim())} onClick={() => void recover(item)}>{t('Récupérer')}</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {localKeyId && !code ? <button type="button" className="legal-vault__show" onClick={() => void showCode()}>{t('Afficher la clé de récupération')}</button> : null}
    </div>
  );
}
