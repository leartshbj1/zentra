import { useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, TrendingUp, FileText, FolderKanban, Receipt } from 'lucide-react';
import type { Project, Workspace } from './types';
import { salesTotalsByCurrency, turnoverLabel } from './salesFinancials';
import { formatMoney } from './utils';
import { MobileDetails } from './MobileDetails';
import { t, useAppLanguage } from './language';

export function MobileDashboard({ workspace, onNavigate, onOpenProject, setup, automation }: {
  workspace: Workspace;
  onNavigate: (view: 'invoices' | 'quotes' | 'projects' | 'accounting' | 'time') => void;
  onOpenProject: (project: Project) => void;
  setup: ReactNode;
  automation?: ReactNode;
}) {
  useAppLanguage();
  const totals = salesTotalsByCurrency(workspace.invoices, workspace.payments);
  const [chosen, setChosen] = useState('CHF');
  const total = totals.find(item => item.currency === chosen) ?? totals[0];
  const projects = workspace.projects.filter(item => ['in_progress', 'paused'].includes(item.status));
  const links = [
    { id: 'invoices' as const, label: 'Factures à encaisser', icon: Receipt, count: workspace.invoices.filter(item => item.type !== 'credit_note' && ['issued', 'partially_paid'].includes(item.status)).length },
    { id: 'quotes' as const, label: 'Devis en préparation', icon: FileText, count: workspace.quotes.filter(item => item.status === 'draft').length },
    { id: 'projects' as const, label: 'Projets actifs', icon: FolderKanban, count: projects.length },
  ];
  return <div className="mobile-home">
    <section className="mobile-home__balance" aria-label={t('Résumé de votre activité')}>
      <div className="mobile-home__balance-heading"><span>{t('Reste à recevoir')}</span>
        {totals.length > 1 ? <select aria-label={t('Devise du résumé')} value={total.currency} onChange={event => setChosen(event.target.value)}>{totals.map(item => <option key={item.currency}>{item.currency}</option>)}</select> : null}
      </div>
      <strong className="mobile-home__amount">{total ? formatMoney(total.openCents, total.currency) : '—'}</strong>
      <span className="mobile-home__period">{t('Toutes périodes')}</span>
      <MobileDetails title="Détail des montants">
        <dl><div><dt>{t('Factures émises · TTC')}</dt><dd>{total ? formatMoney(total.invoicedCents, total.currency) : '—'}</dd></div><div><dt>{t('Paiements reçus')}</dt><dd>{total ? formatMoney(total.paidCents, total.currency) : '—'}</dd></div></dl>
        <p>{t('Montants enregistrés dans Zentra, séparés par devise. Ce résumé ne représente pas le solde bancaire.')}</p>
        <button type="button" onClick={() => onNavigate('accounting')}>{t('Ouvrir la comptabilité')}<ArrowUpRight size={17}/></button>
      </MobileDetails>
    </section>
    {automation}
    <section className="mobile-home__section" aria-label={t('À suivre')}>
      <h2>{t('À suivre')}</h2>
      <div className="mobile-home__list">{links.map(item => <button type="button" key={item.id} onClick={() => onNavigate(item.id)}><item.icon size={21} aria-hidden="true"/><span>{t(item.label)}</span><strong>{item.count}</strong><ChevronRight size={17} aria-hidden="true"/></button>)}</div>
    </section>
    {projects.length > 0 && <section className="mobile-home__section"><div className="mobile-home__section-heading"><h2>{t('Projets actifs')}</h2><button type="button" onClick={() => onNavigate('projects')}>{t('Tout voir')}</button></div>
      <div className="mobile-home__list">{projects.slice(0, 3).map(project => <button type="button" key={project.id} onClick={() => onOpenProject(project)}><FolderKanban size={21}/><span>{project.name}</span><ChevronRight size={17}/></button>)}</div>
    </section>}
    <button type="button" className="mobile-home__time" onClick={() => onNavigate('accounting')}><TrendingUp size={19}/><span>{t('Chiffre d’affaires')}<small className="turnover-period">{t('Facturé hors TVA')} · {new Date().getFullYear()}</small></span><strong>{turnoverLabel(workspace.invoices)}</strong><ChevronRight size={17}/></button>
    {setup && <MobileDetails title="Pour bien démarrer">{setup}</MobileDetails>}
  </div>;
}
