import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import type { LegalArchiveState } from './legalArchive';
import { Button, Field } from './ui';
import { errorMessage, formatDate, formatDateTime } from './utils';
import './erp-registers.css';

const size = (bytes: number) => bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;

/** Archive légale (GeBüV) : une archive par année, conservée dix ans et revérifiable. */
export function LegalArchivePanel({ readOnly }: { readOnly: boolean }) {
  useAppLanguage();
  const [state, setState] = useState<LegalArchiveState | null>(null);
  const [year, setYear] = useState(new Date().getFullYear() - 1);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = async () => setState(await desktopApi.listLegalArchives());
  useEffect(() => { void refresh().catch(() => undefined); }, []);
  const years = [...new Set([new Date().getFullYear() - 1, new Date().getFullYear(), ...(state?.yearsWithEntries ?? [])])].sort((a, b) => b - a);
  async function create() {
    setBusy(true);
    setMessage(t('Préparation de l’archive {year}… Les factures et fiches de salaire sont produites en PDF.', { year }));
    try {
      const result = await desktopApi.createLegalArchive(year);
      setMessage(result.missing
        ? t('Archive {year} créée : {files} fichiers. {missing} document(s) n’ont pas pu être inclus ; la liste figure dans l’archive.', { year, files: result.files, missing: result.missing })
        : t('Archive {year} créée : {files} fichiers, dans {path}.', { year, files: result.files, path: result.path }));
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('L’archive n’a pas pu être créée.')));
    } finally {
      setBusy(false);
    }
  }
  async function verify(id: string) {
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.verifyLegalArchive(id);
      setMessage(result.ok ? t('Archive intacte : chaque fichier correspond à son empreinte.') : result.detail);
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('La vérification n’a pas pu être faite.')));
    } finally {
      setBusy(false);
    }
  }
  return <section className="erp-register" aria-labelledby="legal-archive-title">
    <h2 id="legal-archive-title">{t('Archive légale')}</h2>
    <p>{t('Les livres et les pièces se conservent dix ans. Zentra réunit chaque année le journal, les factures, les fiches de salaire, les justificatifs et l’historique dans une archive dont chaque fichier porte une empreinte vérifiable.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Après la clôture de l’exercice, créez l’archive de l’année : elle est alors « finale ». Avant, elle reste provisoire.')}</li>
        <li>{t('Copiez le fichier sur un second support, par exemple un disque externe ou un stockage en ligne.')}</li>
        <li>{t('Zentra revérifie les archives chaque mois et vous prévient si un fichier manque ou a changé.')}</li>
      </ol>
    </details>
    <div className="erp-register__form">
      <Field label={t('Année')}><select value={year} disabled={busy} onChange={event => setYear(Number(event.target.value))}>{years.map(value => <option key={value} value={value}>{value}</option>)}</select></Field>
      <div className="erp-register__actions">
        <Button type="button" disabled={readOnly || busy} onClick={() => void create()}>{busy ? t('Préparation…') : t('Créer l’archive {year}', { year })}</Button>
        {message ? <p role="status">{message}</p> : null}
      </div>
    </div>
    {state?.archives.length ? <ul className="erp-register__list" aria-label={t('Archives créées')}>
      {state.archives.map(archive => <li key={archive.id}>
        <span>
          <strong>{t('Année {year} · {status}', { year: archive.year, status: archive.status === 'final' ? t('finale') : t('provisoire') })}</strong>
          <small>{t('Créée le {date} · {files} fichiers · {size} · à conserver jusqu’au {until}', { date: formatDate(archive.createdAt), files: archive.filesCount, size: size(archive.sizeBytes), until: formatDate(archive.retainUntil) })}</small>
          <small>{!archive.present ? t('Fichier introuvable sur cet appareil : restaurez votre copie.')
            : archive.lastVerifiedOk === false ? t('Dernière vérification : l’archive a changé.')
              : archive.lastVerifiedAt ? t('Intacte, vérifiée le {date}', { date: formatDateTime(archive.lastVerifiedAt) }) : t('Pas encore vérifiée')}</small>
          {archive.missingCount ? <small>{t('{n} document(s) à compléter : voir 05_a_completer.csv', { n: archive.missingCount })}</small> : null}
        </span>
        <Button type="button" variant="ghost" size="small" disabled={busy || !archive.present} onClick={() => void verify(archive.id)}>{t('Vérifier')}</Button>
      </li>)}
    </ul> : state ? <p>{t('Aucune archive pour le moment.')}</p> : null}
  </section>;
}
