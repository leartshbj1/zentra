import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { Banknote, CircleDollarSign, TrendingUp } from 'lucide-react';
import type { Invoice, Workspace } from './types';
import { salesTotalsByCurrency, formatSalesTotals, turnoverLabel } from './salesFinancials';
import { t, useAppLanguage } from './language';
import { DashboardFinancialDetail, useFinancialDetailSelection } from './DashboardFinancialDetail';

/** Management indicators, not a bank balance or a closed accounting statement. */
export function DashboardFinancialSummary({workspace,onAccounting,onOpenInvoice}:{workspace:Workspace;onAccounting:()=>void;onOpenInvoice:(invoice:Invoice)=>void}) {
  useAppLanguage();
  const {metric,selectMetric,closeDetail}=useFinancialDetailSelection();
  const totals=useMemo(()=>salesTotalsByCurrency(workspace.invoices,workspace.payments),[workspace.invoices,workspace.payments]);
  const hasIssued=workspace.invoices.some(invoice=>!['draft','cancelled'].includes(invoice.status));
  const year=new Date().getFullYear();
  return <section className="workspace-finances">
    <div className="dashboard-overview-heading"><h2>{t('Votre activité en un regard')}</h2><span>{t('Chaque devise est présentée séparément.')}</span></div>
    <div className="metric-grid dashboard-summary" role="group" aria-label={t('Résumé de votre activité')}>
      <MetricCard label={t('Factures émises · TTC')} value={formatSalesTotals(totals,'invoicedCents')} note={t('Cumul de toutes les années · avoirs déduits')} icon={<CircleDollarSign/>} tone="green" expanded={metric==='invoicedCents'} onClick={event=>selectMetric('invoicedCents',event.currentTarget)}/>
      <MetricCard label={t('Paiements reçus')} value={formatSalesTotals(totals,'paidCents')} note={t('Cumul des paiements enregistrés')} icon={<Banknote/>} tone="amber" expanded={metric==='paidCents'} onClick={event=>selectMetric('paidCents',event.currentTarget)}/>
      <MetricCard label={t('Reste à recevoir')} value={formatSalesTotals(totals,'openCents')} note={t('Encore dû · toutes années confondues')} icon={<TrendingUp/>} tone="blue" expanded={metric==='openCents'} onClick={event=>selectMetric('openCents',event.currentTarget)}/>
      <MetricCard label={t('Chiffre d’affaires · {year}',{year})} value={hasIssued?turnoverLabel(workspace.invoices,year):'—'} note={t('Facturé hors TVA · avoirs déduits')} icon={<TrendingUp/>} tone="violet" expanded={metric==='netCents'} onClick={event=>selectMetric('netCents',event.currentTarget)}/>
    </div>
    {metric&&<DashboardFinancialDetail key={metric} workspace={workspace} metric={metric} year={year} onClose={()=>closeDetail()} onOpenInvoice={invoice=>{closeDetail(false);onOpenInvoice(invoice);}}/>}
    <details className="dashboard-finance-guide"><summary>{t('Comment lire ces chiffres ?')}</summary>
      <p>{t('Le reste à recevoir inclut toutes les factures encore dues, même celles des années précédentes. Le chiffre d’affaires porte uniquement sur les factures de {year}, hors TVA et après déduction des avoirs.',{year})}</p>
      <p>{t('Les cumuls regroupent les factures émises et leurs paiements enregistrés, toutes années confondues. Ces montants ne représentent ni votre bénéfice ni le solde bancaire.')}</p>
      <button type="button" onClick={onAccounting}>{t('Ouvrir la comptabilité')}</button>
    </details>
  </section>;
}

function MetricCard({label,value,note,icon,tone,expanded,onClick}:{label:string;value:string;note:string;icon:ReactNode;tone:string;expanded:boolean;onClick:(event:MouseEvent<HTMLButtonElement>)=>void}) {
  return <button type="button" className={`metric-card metric-card--${tone}`} aria-label={`${label} · ${value} · ${note} · ${t('Voir le détail')}`} aria-expanded={expanded} onClick={onClick}><span className="metric-card__icon" aria-hidden="true">{icon}</span><span><span>{label}</span><strong className={value.includes(' · ')?'metric-card__multiple':undefined}>{value.split(' · ').map((part,index)=><b key={index}>{part}</b>)}</strong><small>{note}</small><span className="metric-card__detail-link">{t('Voir le détail')}</span></span></button>;
}
