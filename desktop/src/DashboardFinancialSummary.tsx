import { useMemo, type ReactNode } from 'react';
import { Banknote, CircleDollarSign, TrendingUp } from 'lucide-react';
import type { Workspace } from './types';
import { salesTotalsByCurrency, formatSalesTotals, turnoverLabel } from './salesFinancials';
import { t, useAppLanguage } from './language';

/** Management indicators, not a bank balance or a closed accounting statement. */
export function DashboardFinancialSummary({workspace,onAccounting}:{workspace:Workspace;onAccounting:()=>void}) {
  useAppLanguage();
  const totals=useMemo(()=>salesTotalsByCurrency(workspace.invoices,workspace.payments),[workspace.invoices,workspace.payments]);
  const hasIssued=workspace.invoices.some(invoice=>!['draft','cancelled'].includes(invoice.status));
  const year=new Date().getFullYear();
  return <section className="workspace-finances">
    <div className="dashboard-overview-heading"><h2>{t('Votre activité en un regard')}</h2><span>{t('Chaque devise est présentée séparément.')}</span></div>
    <div className="metric-grid dashboard-summary" role="group" aria-label={t('Résumé de votre activité')}>
      <MetricCard label={t('Factures émises · TTC')} value={formatSalesTotals(totals,'invoicedCents')} note={t('Cumul de toutes les années · avoirs déduits')} icon={<CircleDollarSign/>} tone="green"/>
      <MetricCard label={t('Paiements reçus')} value={formatSalesTotals(totals,'paidCents')} note={t('Cumul des paiements enregistrés')} icon={<Banknote/>} tone="amber"/>
      <MetricCard label={t('Reste à recevoir')} value={formatSalesTotals(totals,'openCents')} note={t('Encore dû · toutes années confondues')} icon={<TrendingUp/>} tone="blue"/>
      <MetricCard label={t('Chiffre d’affaires · {year}',{year})} value={hasIssued?turnoverLabel(workspace.invoices,year):'—'} note={t('Facturé hors TVA · avoirs déduits')} icon={<TrendingUp/>} tone="violet"/>
    </div>
    <details className="dashboard-finance-guide"><summary>{t('Comment lire ces chiffres ?')}</summary>
      <p>{t('Le reste à recevoir inclut toutes les factures encore dues, même celles des années précédentes. Le chiffre d’affaires porte uniquement sur les factures de {year}, hors TVA et après déduction des avoirs.',{year})}</p>
      <p>{t('Les cumuls regroupent les factures émises et leurs paiements enregistrés, toutes années confondues. Ces montants ne représentent ni votre bénéfice ni le solde bancaire.')}</p>
      <button type="button" onClick={onAccounting}>{t('Ouvrir la comptabilité')}</button>
    </details>
  </section>;
}

function MetricCard({label,value,note,icon,tone}:{label:string;value:string;note:string;icon:ReactNode;tone:string}) {
  return <article className={`metric-card metric-card--${tone}`}><div className="metric-card__icon">{icon}</div><div><span>{label}</span><strong className={value.includes(' · ')?'metric-card__multiple':undefined}>{value.split(' · ').map((part,index)=><b key={index}>{part}</b>)}</strong><small>{note}</small></div></article>;
}
