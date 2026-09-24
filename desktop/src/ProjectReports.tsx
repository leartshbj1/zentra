import { t, useAppLanguage } from './language';
import { useState } from 'react';
import { BarChart3, Download, ChevronRight, FileText } from 'lucide-react';
import type { Workspace } from './types';
import { formatMoney, projectFinancials, errorMessage } from './utils';
import { Button, EmptyState, StatusBadge } from './ui';
import { desktopApi } from './bridge';
import { PdfExportReceipt } from './PdfExportReceipt';
import type { PdfExportReceipt as Receipt } from './pdfExportDelivery';
import {
  buildProjectReport,
  reportSections,
  type ReportSectionKey,
} from './projectReport';
import './ProjectReports.css';
export function ReportsScreen({
  workspace,
  onOpenAccounting,
}: {
  workspace: Workspace;
  onOpenAccounting: () => void;
}) {
  useAppLanguage();
  const [chosen, setChosen] = useState(''),
    [sections, setSections] = useState<ReportSectionKey[]>(
      Object.keys(reportSections) as ReportSectionKey[],
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [query, setQuery] = useState('');
  const project = workspace.projects.find((p) => p.id === chosen),
    report = project ? buildProjectReport(workspace, project, sections) : null;
  if (!workspace.projects.length)
    return (
      <EmptyState
        icon={<BarChart3 />}
        title={t('Vos rapports de projet')}
        text={t(
          'Créez un projet pour réunir son activité et ses documents dans un rapport.',
        )}
      />
    );
  async function exportPdf() {
    if (!report || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await desktopApi.exportProjectReportPdf(report);
      if (result) setReceipt(result);
    } catch (e) {
      setError(errorMessage(e, 'Export du rapport impossible.'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className={`project-reports${chosen ? ' project-reports--selected' : ''}`}
    >
      <header className="project-reports__heading">
        <div>
          <h2>{t('Une vue claire de vos projets.')}</h2>
          <p>
            {t(
              'Choisissez un projet. Gardez l’essentiel ou exportez son dossier complet.',
            )}
          </p>
        </div>
        <FileText size={32} />
      </header>
      <div className="project-reports__layout">
        <aside className="project-reports__picker">
          <select
            className="project-reports__mobile-picker"
            aria-label={t('Choisir un projet')}
            value={chosen}
            disabled={busy}
            onChange={(e) => {
              setChosen(e.target.value);
              setReceipt(null);
              setError('');
            }}
          >
            <option value="">{t('Choisir un projet')}</option>
            {workspace.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <label>
            {t('Rechercher un projet')}
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('Nom du projet')}
            />
          </label>
          <div>
            {workspace.projects
              .filter((p) =>
                p.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              )
              .map((p) => (
                <button
                  type="button"
                  disabled={busy}
                  key={p.id}
                  aria-pressed={p.id === chosen}
                  onClick={() => {
                    setChosen(p.id);
                    setReceipt(null);
                    setError('');
                  }}
                >
                  <span>
                    {p.name}
                    <small>
                      {workspace.clients.find((c) => c.id === p.clientId)?.name}
                    </small>
                  </span>
                  <ChevronRight size={17} />
                </button>
              ))}
          </div>
        </aside>
        <section className="project-reports__detail">
          {project && report ? (
            <>
              <div className="project-reports__title">
                <div>
                  <h2>{project.name}</h2>
                  <StatusBadge status={project.status} />
                </div>
                <Button
                  disabled={busy || !sections.length}
                  onClick={() => void exportPdf()}
                >
                  <Download size={17} />
                  {t(busy ? 'Création du PDF…' : 'Exporter le PDF')}
                </Button>
              </div>
              {(() => {
                const s = projectFinancials(
                  project,
                  workspace.invoices,
                  workspace.payments,
                  workspace.timeEntries,
                  workspace.expenses,
                  workspace.supplierInvoices,
                  workspace.supplierCreditNotes,
                );
                return (
                  <>
                    <dl className="project-reports__figures">
                      <div>
                        <dt>{t('Facturé hors TVA')}</dt>
                        <dd>{s.invoicedNetLabel}</dd>
                      </div>
                      <div>
                        <dt>{t('Coûts enregistrés')}</dt>
                        <dd>{formatMoney(s.laborCost + s.expenseNet)}</dd>
                      </div>
                      <div>
                        <dt>{t('Marge de gestion')}</dt>
                        <dd>
                          {s.marginUnavailableReason || formatMoney(s.margin)}
                        </dd>
                      </div>
                    </dl>
                    {s.purchaseCostReviewCount > 0 && (
                      <Button variant="secondary" onClick={onOpenAccounting}>
                        {t('Contrôler les achats')}
                      </Button>
                    )}
                  </>
                );
              })()}
              <fieldset className="project-reports__sections">
                <legend>{t('Dans votre rapport')}</legend>
                {Object.entries(reportSections).map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={sections.includes(key as ReportSectionKey)}
                      onChange={(e) =>
                        setSections((current) =>
                          e.target.checked
                            ? [...current, key as ReportSectionKey]
                            : current.filter((k) => k !== key),
                        )
                      }
                    />
                    {t(label)}
                  </label>
                ))}
              </fieldset>
              {error && <p role="alert">{error}</p>}
              {receipt && (
                <PdfExportReceipt
                  result={receipt}
                  disabled={busy}
                  onBusyChange={setBusy}
                />
              )}
              <div className="project-reports__preview">
                {report.sections.map((s, index) => (
                  <details key={`${index}-${s.title}`} open={index === 0}>
                    <summary>
                      {s.title}
                      <span>{s.rows.length}</span>
                    </summary>
                    <div className="project-reports__table">
                      <table>
                        <thead>
                          <tr>
                            {s.headers.map((h) => (
                              <th key={h}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {!s.rows.length && (
                            <tr>
                              <td colSpan={s.headers.length}>
                                {t('Aucune donnée enregistrée')}
                              </td>
                            </tr>
                          )}
                          {s.rows.map((r, i) => (
                            <tr key={i}>
                              {r.map((cell, j) => (
                                <td key={j}>{cell}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ))}
              </div>
            </>
          ) : (
            <div className="project-reports__empty">
              <BarChart3 size={36} />
              <h3>{t('Quel projet souhaitez-vous examiner ?')}</h3>
              <p>
                {t(
                  'Son rapport réunira les informations déjà enregistrées par votre équipe.',
                )}
              </p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
