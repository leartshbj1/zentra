import { useMemo, useState, type ReactNode } from 'react';
import { ArrowUpRight, ChevronRight, TrendingUp, FileText, FolderKanban, Receipt } from 'lucide-react';
import type { Invoice, Project, Workspace } from './types';
import { salesTotalsByCurrency, turnoverByCurrency } from './salesFinancials';
import { ResponsiveMoney } from './ResponsiveMoney';
import { formatMoney } from './utils';
import { MobileDetails } from './MobileDetails';
import { t, useAppLanguage } from './language';
import { DashboardFinancialDetail, financialMetricLabel, useFinancialDetailSelection } from './DashboardFinancialDetail';

export function MobileDashboard({ workspace, onNavigate, onOpenProject, onOpenInvoice, setup, automation, actions }: {
  workspace: Workspace;
  onNavigate: (view: 'invoices' | 'quotes' | 'projects' | 'accounting' | 'time') => void;
  onOpenProject: (project: Project) => void;
  onOpenInvoice: (invoice: Invoice) => void;
  setup: ReactNode;
  automation?: ReactNode;
  actions?: ReactNode;
}) {
  useAppLanguage();
  const totals = useMemo(() => salesTotalsByCurrency(workspace.invoices, workspace.payments), [workspace.invoices, workspace.payments]);
  const [chosen, setChosen] = useState('CHF');
  const {metric,selectMetric,closeDetail}=useFinancialDetailSelection();
  const year=new Date().getFullYear();
  const turnover = turnoverByCurrency(workspace.invoices, year);
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
      <strong className="mobile-home__amount">{total ? <ResponsiveMoney cents={total.openCents} currency={total.currency} /> : '—'}</strong>
      <span className="mobile-home__period">{t('Encore dû · toutes années confondues')}</span>
      <button type="button" className="mobile-home__calculation-action" aria-expanded={metric==='openCents'} onClick={event=>selectMetric('openCents',event.currentTarget)}>{t('Voir le détail')}<ChevronRight size={17}/></button>
      <MobileDetails title="Détail des montants">
        <dl><div><dt>{t('Factures émises · TTC')}</dt><dd>{total ? formatMoney(total.invoicedCents, total.currency) : '—'}</dd></div><div><dt>{t('Paiements reçus')}</dt><dd>{total ? formatMoney(total.paidCents, total.currency) : '—'}</dd></div></dl>
        <p>{t('Montants enregistrés dans Zentra, séparés par devise. Ce résumé ne représente pas le solde bancaire.')}</p>
        {(['invoicedCents','paidCents'] as const).map(field=><button type="button" key={field} className="mobile-home__calculation-action" onClick={event=>selectMetric(field,event.currentTarget)}>{financialMetricLabel(field,year)}<ArrowUpRight size={17}/></button>)}
      </MobileDetails>
    </section>
    {metric&&<DashboardFinancialDetail key={`${metric}-${total?.currency}`} workspace={workspace} metric={metric} year={year} currency={metric==='netCents'?undefined:total?.currency} onClose={()=>closeDetail()} onOpenInvoice={invoice=>{closeDetail(false);onOpenInvoice(invoice);}}/>}
    {automation}
    {actions}
    <section className="mobile-home__section" aria-label={t('À suivre')}>
      <h2>{t('À suivre')}</h2>
      <div className="mobile-home__list">{links.map(item => <button type="button" key={item.id} onClick={() => onNavigate(item.id)}><item.icon size={21} aria-hidden="true"/><span>{t(item.label)}</span><strong>{item.count}</strong><ChevronRight size={17} aria-hidden="true"/></button>)}</div>
    </section>
    {projects.length > 0 && <section className="mobile-home__section"><div className="mobile-home__section-heading"><h2>{t('Projets actifs')}</h2><button type="button" onClick={() => onNavigate('projects')}>{t('Tout voir')}</button></div>
      <div className="mobile-home__list">{projects.slice(0, 3).map(project => <button type="button" key={project.id} onClick={() => onOpenProject(project)}><FolderKanban size={21}/><span>{project.name}</span><ChevronRight size={17}/></button>)}</div>
    </section>}
    <button type="button" className="mobile-home__time" aria-expanded={metric==='netCents'} onClick={event=>selectMetric('netCents',event.currentTarget)}><TrendingUp size={19}/><span>{t('Chiffre d’affaires')}<small className="turnover-period">{year} · {t('Facturé hors TVA · avoirs déduits')}</small></span><strong>{workspace.invoices.some(invoice=>!['draft','cancelled'].includes(invoice.status)) ? (turnover.length ? turnover : [{ currency: 'CHF', netCents: 0 }]).map(row=><ResponsiveMoney key={row.currency} cents={row.netCents} currency={row.currency}/>) : '—'}</strong><ChevronRight size={17}/></button>
    {setup && <MobileDetails title="Pour bien démarrer">{setup}</MobileDetails>}
  </div>;
}
