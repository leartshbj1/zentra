import { useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import { elmIssues, elmPersons, elmXml } from './elmExport';
import { t, useAppLanguage } from './language';
import type { Workspace } from './types';
import { Button, Field } from './ui';
import { errorMessage, formatDate } from './utils';
import './reminder-charges.css';

type TariffSet = { canton: string; validFrom: string; rows: number; codes: number };

/** Barèmes de l'impôt à la source : import du fichier ESTV du canton. */
export function SourceTaxTariffsPanel({ disabled }: { disabled: boolean }) {
  useAppLanguage();
  const [sets, setSets] = useState<TariffSet[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = () => desktopApi.listSourceTaxTariffSets().then(setSets).catch(() => undefined);
  useEffect(() => { void refresh(); }, []);
  async function load(file?: File) {
    if (!file) return;
    setBusy(true);
    setMessage('');
    try {
      // Les fichiers ESTV sont en ISO-8859-1.
      const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
      const result = await desktopApi.importSourceTaxTariffs(text);
      setMessage(t('{rows} tranches importées : {sets}.', { rows: result.rows, sets: result.sets.map((set) => `${set.canton} ${formatDate(set.validFrom)}`).join(', ') }));
      await refresh();
    } catch (reason) {
      setMessage(errorMessage(reason, t('Le fichier tarifaire n’a pas pu être importé.')));
    } finally {
      setBusy(false);
    }
  }
  return <section className="reminder-charges" aria-labelledby="source-tax-title">
    <h3 id="source-tax-title">{t('Impôt à la source')}</h3>
    <p>{t('Importez le fichier tarifaire de l’ESTV pour chaque canton concerné. Sur la fiche de salaire, Zentra calcule alors la retenue d’après le barème ; vous la vérifiez avant de valider.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Téléchargez sur estv.admin.ch le fichier des barèmes de l’impôt à la source du canton (format texte).')}</li>
        <li>{t('Importez-le ici ; un nouveau fichier remplace le barème du même canton et de la même date.')}</li>
        <li>{t('Sur la fiche, indiquez le canton et le code tarifaire de la personne (par exemple A0N).')}</li>
      </ol>
    </details>
    <Field label={t('Fichier tarifaire ESTV')}><input type="file" accept=".txt,text/plain" disabled={disabled || busy} onChange={(event) => { void load(event.target.files?.[0]); event.target.value = ''; }} /></Field>
    {message ? <p role="status">{message}</p> : null}
    {sets.length ? <ul className="reminder-charges__sets">{sets.map((set) => <li key={set.canton + set.validFrom}>{t('{canton} · en vigueur dès le {date} · {codes} codes tarifaires', { canton: set.canton, date: formatDate(set.validFrom), codes: set.codes })}</li>)}</ul> : null}
  </section>;
}

/** Structure de déclaration des salaires Swissdec ELM, préparée pour la fiduciaire. */
export function ElmExportPanel({ workspace, disabled }: { workspace: Workspace; disabled: boolean }) {
  useAppLanguage();
  const [year, setYear] = useState(new Date().getFullYear() - (new Date().getMonth() < 2 ? 1 : 0));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const persons = elmPersons(workspace.employees, workspace.payslips, year);
  const issues = elmIssues(persons, workspace);
  async function save() {
    setBusy(true);
    setMessage('');
    try {
      const result = await desktopApi.exportElmStructure(year, elmXml(workspace, persons, year, new Date().toISOString().slice(0, 10)));
      if (result) setMessage(t('Structure ELM enregistrée : {path}', { path: result.path }));
    } catch (reason) {
      setMessage(errorMessage(reason, t('La structure ELM n’a pas pu être enregistrée.')));
    } finally {
      setBusy(false);
    }
  }
  return <section className="reminder-charges" aria-labelledby="elm-title">
    <h3 id="elm-title">{t('Déclaration des salaires Swissdec (ELM)')}</h3>
    <p>{t('Zentra prépare la structure de la déclaration annuelle : entreprise, personnes, périodes et revenus AVS/AC. Elle n’est ni certifiée Swissdec ni transmise : votre fiduciaire ou votre logiciel certifié s’en charge.')}</p>
    <Field label={t('Année')}><select value={year} disabled={disabled || busy} onChange={(event) => setYear(Number(event.target.value))}>{[0, 1, 2].map((offset) => new Date().getFullYear() - offset).map((value) => <option key={value} value={value}>{value}</option>)}</select></Field>
    <p>{t('{n} personne(s) avec des fiches validées en {year}.', { n: persons.length, year })}</p>
    {issues.length ? <div role="note"><p>{t('À compléter avant l’envoi par votre fiduciaire :')}</p><ul className="reminder-charges__sets">{issues.map((issue) => <li key={issue}>{t(issue)}</li>)}</ul></div> : null}
    <div className="reminder-charges__actions">
      <Button type="button" variant="secondary" disabled={disabled || busy || !persons.length} onClick={() => void save()}>{busy ? t('Enregistrement…') : t('Préparer la structure ELM')}</Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  </section>;
}
