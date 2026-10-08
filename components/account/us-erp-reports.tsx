'use client';

import { useCallback, useEffect, useId, useRef, useState, type SubmitEvent } from 'react';
import type { SiteLanguage } from '@/lib/site-language';
import { browserSalesCopy, browserExportErrorCopy } from '@/lib/international/browser-sales-copy';
import { BrowserExportError, createBrowserExportSession, type BrowserExportFormat, type BrowserExportSession } from '@/lib/international/browser-export-session';
import { validateUsExportSelector, type ExportSelector, type ExportSnapshot } from '@/lib/international/export-snapshot';
import { exportCopy } from '@/lib/international/export-copy';
import { formatMoney, money } from '@/lib/international/money';
import type { ErpState } from '@/lib/international/runtime-types';
import './us-erp-reports.css';

interface ExportAccess {
  organizationId: string; expectedUserId: string; supportedSchemaVersion: 1 | 2; language: SiteLanguage;
  accessEpoch: number; currentAccessEpoch: () => number; disabled: boolean; onAccessDenied: () => void; sellerSettingsId?: string;
}
type ExportNotice = 'failure' | 'saved' | keyof typeof browserExportErrorCopy.en;
function exportNotice(error: unknown): ExportNotice {
  if (!(error instanceof BrowserExportError)) return 'failure';
  if (error.code === 'seller_configuration_required') return 'sellerRequired';
  if (error.code === 'unsupported_export_glyph') return 'unsupportedGlyph';
  if (error.code === 'rate_limited') return 'rateLimited';
  if (['export_revision_changed', 'configuration_changed'].includes(error.code)) return 'stale';
  return 'failure';
}
const locales: Record<SiteLanguage, string> = { fr: 'fr-US', de: 'de-US', it: 'it-US', en: 'en-US' };
/** The download starts only after the cookie-authorized response, snapshot
 * metadata and byte digest are verified. It never opens executable HTML. */
export function UsDocumentExports(props: ExportAccess & { selector: ExportSelector; revision: number; exactRevision?: number }) {
  const c = browserSalesCopy[props.language], session = useRef<BrowserExportSession | null>(null), generation = useRef(0), working = useRef(false);
  const { organizationId, expectedUserId, supportedSchemaVersion, accessEpoch } = props;
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<ExportNotice | null>(null);
  const invalidate = useCallback(() => { generation.current++; session.current = null; }, []);
  useEffect(() => {
    const instance = createBrowserExportSession({ organizationId, expectedUserId, supportedSchemaVersion }); session.current = instance;
    return () => { invalidate(); instance.dispose(); };
  }, [organizationId, expectedUserId, supportedSchemaVersion, accessEpoch, invalidate]);
  async function download(format: Exclude<BrowserExportFormat, 'json'>) {
    const instance = session.current, current = generation.current, epoch = props.accessEpoch;
    if (!instance || working.current || props.disabled || epoch !== props.currentAccessEpoch()) return;
    working.current = true; setBusy(true); setNotice(null);
    try {
      const result = await instance.file(props.selector, props.language, props.revision, format, props.exactRevision);
      if (current !== generation.current || epoch !== props.currentAccessEpoch()) return;
      instance.download(result); setNotice('saved');
    } catch (error) {
      if (current !== generation.current || epoch !== props.currentAccessEpoch()) return;
      if (error instanceof BrowserExportError && error.unauthorized) props.onAccessDenied();
      else setNotice(exportNotice(error));
    } finally { if (current === generation.current) { working.current = false; setBusy(false); } }
  }
  return <div className="us-erp-export" aria-busy={busy}>
    <div className="us-erp-actions"><button type="button" className="account-button secondary" disabled={props.disabled || busy} onClick={() => void download('pdf')}>{busy ? c.exportBusy : c.exportPdf}</button>
      <details className="us-export-more"><summary>{c.export}</summary><button type="button" className="account-button secondary" disabled={props.disabled || busy} onClick={() => void download('csv')}>{c.exportCsv}</button><button type="button" className="account-button secondary" disabled={props.disabled || busy} onClick={() => void download('html')}>{c.exportHtml}</button></details></div>
    {notice && <p className={notice === 'saved' ? 'us-erp-muted' : 'us-erp-export-error'} role={notice === 'saved' ? 'status' : 'alert'}>{notice === 'failure' ? c.exportFailure : notice === 'saved' ? c.exportSaved : browserExportErrorCopy[props.language][notice]}{notice === 'sellerRequired' && props.sellerSettingsId && <> <a href={`#${props.sellerSettingsId}`} onClick={() => document.getElementById(props.sellerSettingsId!)?.focus()}>{browserSalesCopy[props.language].company}</a></>}</p>}
  </div>;
}

export function UsExportReportTable({ snapshot, language }: { snapshot: ExportSnapshot; language: SiteLanguage }) {
  const labels = exportCopy[language], [page, setPage] = useState(0), id = useId(), count = Math.max(1, Math.ceil(snapshot.rows.length / 50));
  const pagination: Record<SiteLanguage, readonly [string, string, string]> = { en: ['Previous', 'Next', 'Page'], fr: ['Précédent', 'Suivant', 'Page'], de: ['Zurück', 'Weiter', 'Seite'], it: ['Precedente', 'Successiva', 'Pagina'] };
  return <>
    <dl className="us-erp-facts"><div><dt>{snapshot.selector.kind === 'report' ? labels.company : labels.seller}</dt><dd>{snapshot.seller.name}</dd></div>{snapshot.facts.map((fact, index) => <div key={`${fact.label}-${index}`}><dt>{labels[fact.label]}</dt><dd>{fact.value}</dd></div>)}</dl>
    {/* oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Labelled scroll region needs keyboard access when desktop columns overflow. */}
    <section className="us-report-table-wrap" aria-labelledby={id} tabIndex={0}><h3 id={id} className="us-erp-visually-hidden">{snapshot.selector.kind === 'report' ? labels[snapshot.selector.reportType] : labels[snapshot.selector.documentType]}</h3><table className="us-report-table"><thead><tr>{snapshot.columns.map(column => <th key={column.label} scope="col">{labels[column.label]}</th>)}</tr></thead><tbody>{snapshot.rows.slice(page * 50, (page + 1) * 50).map((row, rowIndex) => <tr key={`${page}-${rowIndex}`}>{row.map((value, index) => <td key={snapshot.columns[index].label} data-label={labels[snapshot.columns[index].label]} data-money={snapshot.columns[index].kind === 'money'}>{snapshot.columns[index].kind === 'money' ? formatMoney(money('USD', value), locales[language]) : snapshot.columns[index].label === 'accountType' ? value === 'asset' ? labels.assets : value === 'liability' ? labels.liabilities : labels[value as 'income' | 'expense' | 'equity'] : value}</td>)}</tr>)}</tbody></table></section>
    {count > 1 && <nav className="us-erp-actions us-report-pagination" aria-label={pagination[language][2]}><button type="button" className="account-button secondary" disabled={page === 0} onClick={() => setPage(previous => Math.max(0, previous - 1))}>{pagination[language][0]}</button><span>{pagination[language][2]} {page + 1} / {count}</span><button type="button" className="account-button secondary" disabled={page === count - 1} onClick={() => setPage(previous => Math.min(count - 1, previous + 1))}>{pagination[language][1]}</button></nav>}
    <dl className="us-report-totals">{snapshot.totals.map(total => <div key={total.label}><dt>{labels[total.label]}</dt><dd>{formatMoney(money('USD', total.minorUnits), locales[language])}</dd></div>)}</dl>
    {snapshot.notes && <p className="us-erp-notes us-erp-muted">{snapshot.notes}</p>}
  </>;
}

export function UsErpReports(props: ExportAccess & { state: ErpState }) {
  const c = browserSalesCopy[props.language], prefix = useId(), session = useRef<BrowserExportSession | null>(null), generation = useRef(0), working = useRef(false);
  const { organizationId, expectedUserId, supportedSchemaVersion, accessEpoch, language } = props;
  const revision = props.state.revision, identity = `${revision}:${language}`;
  const [kind, setKind] = useState<Extract<ExportSelector, { kind: 'report' }>['reportType']>('trial_balance'), [asOf, setAsOf] = useState(''), [start, setStart] = useState(''), [end, setEnd] = useState(''), [accountId, setAccountId] = useState('');
  const [savedSnapshot, setSnapshot] = useState<ExportSnapshot | null>(null), [pendingBusy, setBusy] = useState(false), [requestIdentity, setRequestIdentity] = useState(''), [savedError, setError] = useState<'reportInvalid' | 'reportFailure' | 'reportStale' | keyof typeof browserExportErrorCopy.en | null>(null);
  // Rendering never exposes a snapshot from the previous language or revision,
  // even before the transport-cleanup effect has run.
  const snapshot = savedSnapshot?.erpRevision === revision && savedSnapshot.language === language ? savedSnapshot : null;
  const busy = pendingBusy && requestIdentity === identity;
  const error = savedSnapshot && !snapshot ? 'reportStale' : savedError;
  const invalidateTransport = useCallback(() => { generation.current++; session.current?.dispose(); session.current = null; working.current = false; }, []);
  const resetTransport = useCallback(() => {
    invalidateTransport(); session.current = createBrowserExportSession({ organizationId, expectedUserId, supportedSchemaVersion });
  }, [organizationId, expectedUserId, supportedSchemaVersion, invalidateTransport]);
  // Revision/language changes invalidate in-flight reads even with no snapshot.
  useEffect(() => { resetTransport(); return invalidateTransport; }, [resetTransport, invalidateTransport, accessEpoch, revision, language]);
  function edited(change: () => void) { change(); setSnapshot(null); setError(null); setBusy(false); resetTransport(); }
  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault(); const instance = session.current, current = generation.current, epoch = props.accessEpoch;
    if (!instance || working.current || props.disabled || epoch !== props.currentAccessEpoch()) return;
    let selector: ExportSelector;
    try { selector = validateUsExportSelector(kind === 'trial_balance' || kind === 'balance_sheet' ? { kind: 'report', reportType: kind, asOf } : kind === 'general_ledger' ? { kind: 'report', reportType: kind, start, end, accountId } : { kind: 'report', reportType: kind, start, end }); }
    catch { setError('reportInvalid'); return; }
    working.current = true; setRequestIdentity(identity); setBusy(true); setError(null); setSnapshot(null);
    try {
      const value = await instance.load(selector, props.language, props.state.revision);
      if (current !== generation.current || epoch !== props.currentAccessEpoch()) return;
      if (value.erpRevision !== props.state.revision) setError('reportStale'); else setSnapshot(value);
    } catch (failure) {
      if (current !== generation.current || epoch !== props.currentAccessEpoch()) return;
      if (failure instanceof BrowserExportError && failure.unauthorized) props.onAccessDenied(); else if (failure instanceof BrowserExportError && failure.code === 'invalid_export_selector') setError('reportInvalid'); else { const mapped = exportNotice(failure); setError(mapped === 'failure' || mapped === 'saved' ? 'reportFailure' : mapped); }
    } finally { if (current === generation.current) { working.current = false; setBusy(false); } }
  }
  const range = kind !== 'trial_balance' && kind !== 'balance_sheet';
  return <section className="us-erp-section us-erp-reports" aria-label={c.reports}><h2>{c.reports}</h2><p className="us-erp-muted">{c.reportsHelp}</p>
    <form onSubmit={event => void submit(event)}><fieldset className="us-erp-form" disabled={props.disabled || busy}><div className="us-erp-select-field"><label htmlFor={`${prefix}-kind`}>{c.reportKind}</label><select id={`${prefix}-kind`} value={kind} onChange={event => edited(() => setKind(event.target.value as typeof kind))}>{(['trial_balance', 'profit_loss', 'balance_sheet', 'cash_flow', 'general_ledger'] as const).map(report => <option key={report} value={report}>{c[report]}</option>)}</select></div>
      <div className="us-erp-grid">{range ? <><label>{c.start}<input type="date" required value={start} onChange={event => edited(() => setStart(event.target.value))} /></label><label>{c.end}<input type="date" required value={end} onChange={event => edited(() => setEnd(event.target.value))} /></label></> : <label>{c.asOf}<input type="date" required value={asOf} onChange={event => edited(() => setAsOf(event.target.value))} /></label>}</div>
      {kind === 'general_ledger' && <div className="us-erp-select-field"><label htmlFor={`${prefix}-account`}>{c.account}</label><select id={`${prefix}-account`} required value={accountId} onChange={event => edited(() => setAccountId(event.target.value))}><option value="">—</option>{props.state.ledger.accounts.map(account => <option key={account.id} value={account.id}>{account.code} · {account.name}</option>)}</select></div>}
      <button type="submit" className="account-button">{busy ? c.reportLoading : c.showReport}</button></fieldset></form>
    {error && <p className="us-erp-export-error" role="alert">{error === 'reportInvalid' || error === 'reportFailure' || error === 'reportStale' ? c[error] : browserExportErrorCopy[props.language][error]}{error === 'sellerRequired' && props.sellerSettingsId && <> <a href={`#${props.sellerSettingsId}`} onClick={() => document.getElementById(props.sellerSettingsId!)?.focus()}>{c.company}</a></>}</p>}
    {!snapshot && !error && !busy && <p className="us-erp-muted us-report-result">{c.reportEmpty}</p>}
    {snapshot && <div className="us-report-result"><h3>{snapshot.selector.kind === 'report' ? c[snapshot.selector.reportType] : c.reports}</h3><p className="us-erp-muted">{c.revision} {snapshot.erpRevision}</p><UsExportReportTable key={`${JSON.stringify(snapshot.selector)}:${snapshot.erpRevision}:${snapshot.language}`} snapshot={snapshot} language={props.language} /><UsDocumentExports {...props} selector={snapshot.selector} revision={snapshot.erpRevision} exactRevision={snapshot.erpRevision} /></div>}
  </section>;
}
