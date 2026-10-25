import { useMemo, useState } from 'react';
import { desktopApi } from './bridge';
import { localDate } from './cashBook';
import { t, useAppLanguage } from './language';
import { clientPriceList, listUnitPrice } from './priceLists';
import { SignaturePad, SignatureView } from './SignaturePad';
import type { WorkReport, WorkReportLine, Workspace } from './types';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage, formatDate, formatMoney } from './utils';
import { reportTotals } from './workReports';
import './erp-registers.css';

type LineDraft = Omit<WorkReportLine, 'id'> & { priceText: string; quantityText: string };
type Draft = { id?: string; clientId: string; projectId: string | null; reportDate: string; site: string; description: string; technician: string; lines: LineDraft[] };

const cents = (value: string) => {
  const match = /^\s*(\d{1,9})(?:[.,](\d{1,2}))?\s*$/.exec(value.replace(/['’\s]/g, ''));
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
};
const quantity = (value: string) => {
  const parsed = Number(value.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : null;
};

/** Rapports de régie : saisie sur place, signature du client, puis facture en brouillon. */
export function WorkReportsPanel({ workspace, disabled, onWorkspace, onOpenInvoice, onDictate }: { workspace: Workspace; disabled: boolean; onWorkspace: (next: Workspace) => void; onOpenInvoice: (invoiceId: string) => void; onDictate?: () => void }) {
  useAppLanguage();
  const today = localDate(new Date());
  const reports = useMemo(() => [...(workspace.workReports ?? [])].sort((a, b) => b.reportDate.localeCompare(a.reportDate)), [workspace.workReports]);
  const clients = workspace.clients.filter((client) => !client.archivedAt);
  const defaultVat = workspace.settings?.organization.vatRegistered ? workspace.settings.billing.vatRatesBp[0] ?? 810 : 0;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [signing, setSigning] = useState<WorkReport | null>(null);
  const [signer, setSigner] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const locked = disabled || busy;
  const clientName = (id: string) => clients.find((client) => client.id === id)?.name ?? workspace.clients.find((client) => client.id === id)?.name ?? '';

  async function run<T>(action: () => Promise<T>, after?: (value: T) => void) {
    setBusy(true);
    setError('');
    try {
      after?.(await action());
    } catch (reason) {
      setError(errorMessage(reason, t('Le rapport n’a pas pu être enregistré.')));
    } finally {
      setBusy(false);
    }
  }
  const newLine = (kind: LineDraft['kind']): LineDraft => ({ kind, catalogItemId: null, description: kind === 'labor' ? t('Main-d’œuvre') : '', quantity: 1, unit: kind === 'labor' ? 'h' : 'pce', unitPriceCents: 0, vatBp: defaultVat, priceText: '', quantityText: '1' });
  const toDraft = (report?: WorkReport): Draft => report
    ? { ...report, lines: report.lines.map((line) => ({ ...line, priceText: (line.unitPriceCents / 100).toFixed(2), quantityText: String(line.quantity) })) }
    : { clientId: clients[0]?.id ?? '', projectId: null, reportDate: today, site: '', description: '', technician: '', lines: [newLine('labor')] };
  const setLine = (index: number, patch: Partial<LineDraft>) => setDraft((current) => current ? { ...current, lines: current.lines.map((line, i) => (i === index ? { ...line, ...patch } : line)) } : current);

  function save(thenSign: boolean) {
    if (!draft) return;
    const lines: Omit<WorkReportLine, 'id'>[] = [];
    for (const line of draft.lines) {
      const price = cents(line.priceText || '0'), amount = quantity(line.quantityText);
      if (price === null || amount === null || !line.description.trim()) { setError(t('Vérifiez chaque ligne : description, quantité et prix.')); return; }
      lines.push({ kind: line.kind, catalogItemId: line.catalogItemId, description: line.description.trim(), quantity: amount, unit: line.unit, unitPriceCents: price, vatBp: line.vatBp });
    }
    void run(() => desktopApi.saveWorkReport({ ...draft, lines }), (result) => {
      onWorkspace(result.workspace);
      setDraft(null);
      if (thenSign) {
        const saved = result.workspace.workReports?.find((report) => report.id === result.id);
        if (saved) { setSigning(saved); setSigner(''); setSignature(''); }
      }
    });
  }

  if (signing) {
    const totals = reportTotals(signing.lines);
    return <section className="erp-register work-report-sign" aria-labelledby="work-report-sign-title">
      <h2 id="work-report-sign-title">{t('Signature du client')}</h2>
      <p>{t('{client} · {date} · {hours} h et {materials} matériel(s) · {amount}', { client: clientName(signing.clientId), date: formatDate(signing.reportDate), hours: totals.hours, materials: totals.materials, amount: formatMoney(totals.totalCents) })}</p>
      <ul className="erp-register__list">
        {signing.lines.map((line) => <li key={line.id}><span><strong>{line.description}</strong><small>{line.quantity} {line.unit}</small></span></li>)}
      </ul>
      {error ? <ErrorPanel message={error} /> : null}
      <Field label={t('Nom de la personne qui signe')}><input value={signer} maxLength={200} disabled={locked} onChange={(event) => setSigner(event.target.value)} /></Field>
      <SignaturePad disabled={locked} onChange={setSignature} />
      <div className="erp-register__actions">
        <Button disabled={locked || !signer.trim() || !signature} onClick={() => void run(() => desktopApi.signWorkReport(signing.id, signer, signature), (next) => { onWorkspace(next); setSigning(null); })}>{busy ? t('Enregistrement…') : t('Valider la signature')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setSigning(null)}>{t('Annuler')}</Button>
      </div>
    </section>;
  }

  return <section className="erp-register" aria-labelledby="work-reports-title">
    <h2 id="work-reports-title">{t('Rapports d’intervention')}</h2>
    <p>{t('Notez les heures et le matériel chez le client, faites signer sur le téléphone, puis créez la facture en un clic.')}</p>
    <details>
      <summary>{t('Comment ça marche')}</summary>
      <ol>
        <li>{t('Créez le rapport sur place : client, travail effectué, heures et matériel.')}</li>
        <li>{t('Faites signer le client au doigt. Le rapport signé ne se modifie plus.')}</li>
        <li>{t('Autopilote propose ensuite la facture : elle reprend exactement les lignes signées.')}</li>
      </ol>
    </details>
    {error ? <ErrorPanel message={error} /> : null}
    {!draft ? <div className="erp-register__actions"><Button disabled={locked || !clients.length} onClick={() => { setDraft(toDraft()); setError(''); }}>{t('Nouveau rapport')}</Button>
      {onDictate ? <Button variant="secondary" disabled={locked || !clients.length} onClick={onDictate}>{t('Dicter un rapport')}</Button> : null}
      {!clients.length ? <p>{t('Ajoutez d’abord un client.')}</p> : null}</div> : <div className="erp-register__form">
      <Field label={t('Client')}>
        <select value={draft.clientId} disabled={locked} onChange={(event) => setDraft({ ...draft, clientId: event.target.value })}>
          {clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}
        </select>
      </Field>
      <Field label={t('Date')}><input type="date" value={draft.reportDate} disabled={locked} onChange={(event) => setDraft({ ...draft, reportDate: event.target.value })} /></Field>
      <Field label={t('Lieu')}><input value={draft.site} maxLength={300} disabled={locked} onChange={(event) => setDraft({ ...draft, site: event.target.value })} /></Field>
      <Field label={t('Intervenant')}><input value={draft.technician} maxLength={200} disabled={locked} onChange={(event) => setDraft({ ...draft, technician: event.target.value })} /></Field>
      <div className="erp-register__wide"><Field label={t('Travail effectué')}><textarea rows={3} value={draft.description} maxLength={4000} disabled={locked} onChange={(event) => setDraft({ ...draft, description: event.target.value })} /></Field></div>
      {draft.lines.map((line, index) => <div key={index} className="erp-register__wide work-report-line">
        <Field label={t(line.kind === 'labor' ? 'Heures' : 'Matériel')}>
          {line.kind === 'material' ? <select value={line.catalogItemId ?? ''} disabled={locked} onChange={(event) => {
            const item = workspace.catalogItems.find((row) => row.id === event.target.value);
            const price = item ? listUnitPrice(item.id, item.salesPriceCents, clientPriceList(workspace.priceLists, draft.clientId)) : 0;
            setLine(index, item ? { catalogItemId: item.id, description: item.name, unit: item.unit || 'pce', unitPriceCents: price, priceText: (price / 100).toFixed(2), vatBp: item.vatBp } : { catalogItemId: null });
          }}>
            <option value="">{t('Article libre')}</option>
            {workspace.catalogItems.filter((row) => !row.archivedAt).map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
          </select> : null}
          <input value={line.description} maxLength={500} disabled={locked} placeholder={t('Description')} onChange={(event) => setLine(index, { description: event.target.value })} />
        </Field>
        <Field label={t(line.kind === 'labor' ? 'Heures' : 'Quantité')}><input inputMode="decimal" value={line.quantityText} disabled={locked} onChange={(event) => setLine(index, { quantityText: event.target.value })} /></Field>
        <Field label={t(line.kind === 'labor' ? 'Tarif horaire' : 'Prix unitaire')}><input inputMode="decimal" placeholder="0.00" value={line.priceText} disabled={locked} onChange={(event) => setLine(index, { priceText: event.target.value })} /></Field>
        <button type="button" className="work-report-line__remove" disabled={locked} onClick={() => setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })}>{t('Retirer')}</button>
      </div>)}
      <div className="erp-register__actions">
        <Button variant="secondary" disabled={locked} onClick={() => setDraft({ ...draft, lines: [...draft.lines, newLine('labor')] })}>{t('Ajouter des heures')}</Button>
        <Button variant="secondary" disabled={locked} onClick={() => setDraft({ ...draft, lines: [...draft.lines, newLine('material')] })}>{t('Ajouter du matériel')}</Button>
      </div>
      <div className="erp-register__actions">
        <Button disabled={locked || !draft.clientId || !draft.description.trim() || !draft.lines.length} onClick={() => save(true)}>{t('Enregistrer et faire signer')}</Button>
        <Button variant="secondary" disabled={locked || !draft.clientId || !draft.description.trim()} onClick={() => save(false)}>{t('Enregistrer le brouillon')}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setDraft(null)}>{t('Annuler')}</Button>
      </div>
    </div>}
    {reports.length ? <ul className="erp-register__list">
      {reports.map((report) => {
        const totals = reportTotals(report.lines);
        return <li key={report.id}>
          <span>
            <strong>{clientName(report.clientId)} · {formatDate(report.reportDate)}</strong>
            <small>{report.status === 'draft' ? t('Brouillon · pas encore signé') : report.status === 'signed'
              ? t('Signé par {name} · à facturer', { name: report.signerName }) : t('Signé par {name} · facturé', { name: report.signerName })}</small>
            <small>{t('{hours} h et {materials} matériel(s)', { hours: totals.hours, materials: totals.materials })}</small>
          </span>
          <span className="erp-register__amount">{formatMoney(totals.totalCents)}</span>
          {report.signaturePath ? <span className="erp-register__wide work-report-signature"><SignatureView path={report.signaturePath} label={t('Signature de {name}', { name: report.signerName })} /></span> : null}
          <span className="erp-register__links">
            {report.status === 'draft' ? <>
              <button type="button" disabled={locked} onClick={() => { setSigning(report); setSigner(''); setSignature(''); setError(''); }}>{t('Faire signer')}</button>
              <button type="button" disabled={locked} onClick={() => { setDraft(toDraft(report)); setError(''); }}>{t('Modifier')}</button>
              <button type="button" disabled={locked} onClick={() => { if (window.confirm(t('Supprimer ce rapport non signé ?'))) void run(() => desktopApi.deleteWorkReport(report.id), onWorkspace); }}>{t('Supprimer')}</button>
            </> : report.status === 'signed'
              ? <button type="button" disabled={locked} onClick={() => void run(() => desktopApi.invoiceWorkReport(report.id), (result) => { onWorkspace(result.workspace); onOpenInvoice(result.invoiceId); })}>{t('Créer la facture')}</button>
              : report.invoiceId ? <button type="button" onClick={() => onOpenInvoice(report.invoiceId!)}>{t('Voir la facture')}</button> : null}
          </span>
        </li>;
      })}
    </ul> : !draft ? <p>{t('Aucun rapport pour l’instant.')}</p> : null}
  </section>;
}
