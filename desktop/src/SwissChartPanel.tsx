import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import { errorMessage } from './utils';
import './swiss-chart.css';

type Preview = { total: number; present: number; missing: { code: string; name: string }[] };

/** Compléter le plan comptable avec le plan PME suisse, sans toucher aux comptes existants. */
export function SwissChartPanel({ disabled, version, onCompleted }: { disabled: boolean; version: number; onCompleted: (added: number) => Promise<void> }) {
  useAppLanguage();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    desktopApi.swissSmeChartPreview().then((value) => { if (live) setPreview(value); }).catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [version]);
  if (!preview || preview.missing.length === 0) return null;
  const count = preview.missing.length;
  return <section className="swiss-chart" aria-labelledby="swiss-chart-title">
    <div>
      <h3 id="swiss-chart-title">{t('Plan comptable PME suisse')}</h3>
      <p>{count === 1
        ? t('1 compte du plan PME manque dans votre plan. Il est ajouté sans modifier vos comptes existants.')
        : t('{count} comptes du plan PME manquent dans votre plan. Ils sont ajoutés sans modifier vos comptes existants.', { count })}</p>
      <details>
        <summary>{t('Voir les comptes à ajouter')}</summary>
        <ul>{preview.missing.map((account) => <li key={account.code}><span>{account.code}</span> {account.name}</li>)}</ul>
      </details>
      {error && <p role="alert">{error}</p>}
    </div>
    <Button type="button" disabled={disabled || working} onClick={async () => {
      setWorking(true); setError('');
      try {
        const result = await desktopApi.completeSwissSmeChart();
        await onCompleted(result.added);
      } catch (reason) {
        setError(errorMessage(reason, t('Les comptes n’ont pas pu être ajoutés.')));
      } finally { setWorking(false); }
    }}>{working ? t('Ajout…') : count === 1 ? t('Ajouter le compte') : t('Ajouter les {count} comptes', { count })}</Button>
  </section>;
}
