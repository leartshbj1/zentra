import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, X } from 'lucide-react';
import type { Invoice, Workspace } from './types';
import { salesMetricRows, type SalesMetric } from './salesFinancials';
import { formatDate, formatMoney } from './utils';
import { t, useAppLanguage } from './language';
import { Button } from './ui';
import './DashboardFinancialDetail.css';

export const financialMetricLabel = (metric: SalesMetric, year: number) => t({
  invoicedCents: 'Factures émises · TTC', paidCents: 'Paiements reçus',
  openCents: 'Reste à recevoir', netCents: 'Chiffre d’affaires · {year}',
}[metric], {year});

export function useFinancialDetailSelection() {
  const [metric,setMetric]=useState<SalesMetric|null>(null);
  const trigger=useRef<HTMLButtonElement|null>(null);
  function closeDetail(restoreFocus=true) {
    setMetric(null);
    if(restoreFocus&&trigger.current?.isConnected)trigger.current.focus({preventScroll:true});
  }
  function selectMetric(next:SalesMetric,button:HTMLButtonElement) {
    if(next===metric){closeDetail();return;}
    trigger.current=button;setMetric(next);
  }
  return {metric,selectMetric,closeDetail};
}

/** Read-only explanation of a dashboard figure, using the same recorded contributions. */
export function DashboardFinancialDetail({workspace,metric,year,currency,onClose,onOpenInvoice}:{
  workspace: Workspace; metric: SalesMetric; year: number; currency?: string;
  onClose:()=>void; onOpenInvoice:(invoice:Invoice)=>void;
}) {
  useAppLanguage();
  const heading=useRef<HTMLHeadingElement>(null);
  const [limit,setLimit]=useState(20);
  const rows=useMemo(()=>salesMetricRows(workspace.invoices,workspace.payments,metric,year).filter(row=>!currency||row.currency===currency),[workspace.invoices,workspace.payments,metric,year,currency]);
  const totals=new Map<string,number>();
  for(const row of rows)totals.set(row.currency,(totals.get(row.currency)??0)+row[metric]);
  useEffect(()=>{heading.current?.focus();},[]);
  const explanation=metric==='netCents'
    ? 'Factures et avoirs émis dans l’année, hors TVA. Les brouillons et documents annulés sont exclus.'
    : metric==='openCents'
      ? 'Montant TTC restant sur chaque facture, après paiements et avoirs. Toutes années confondues.'
      : metric==='paidCents'
        ? 'Paiements et remboursements enregistrés, regroupés par facture. Toutes années confondues.'
        : 'Factures émises et avoirs TTC, toutes années confondues. Les brouillons et documents annulés sont exclus.';
  return <section className="financial-detail" aria-label={t('Détail du calcul')}>
    <header><h3 ref={heading} tabIndex={-1}>{financialMetricLabel(metric,year)}</h3><Button variant="ghost" size="icon" aria-label={t('Fermer le détail')} onClick={onClose}><X size={19}/></Button></header>
    <p className="financial-detail__explanation">{t(explanation)}</p>
    <dl className="financial-detail__totals">{[...totals].sort(([a],[b])=>a.localeCompare(b)).map(([code,amount])=><div key={code}><dt>{t('Total')} · {code}</dt><dd>{formatMoney(amount,code)}</dd></div>)}</dl>
    <p className="financial-detail__count">{t(rows.length===1?'1 document dans ce calcul':'{count} documents dans ce calcul',{count:rows.length})}</p>
    {rows.length ? <ul>{rows.slice(0,limit).map(({invoice,...row})=><li key={invoice.id}><button type="button" onClick={()=>onOpenInvoice(invoice)}>
      <span className="financial-detail__document"><strong>{invoice.number||t('Sans numéro')}{invoice.type==='credit_note'?` · ${t('Avoir')}`:''}</strong><span>{workspace.clients.find(client=>client.id===invoice.clientId)?.company||workspace.clients.find(client=>client.id===invoice.clientId)?.name||invoice.title}</span><small>{formatDate(invoice.issueDate)}</small></span>
      <strong className="financial-detail__amount">{formatMoney(row[metric],row.currency)}</strong><ChevronRight size={17} aria-hidden="true"/>
    </button></li>)}</ul>:<p>{t('Aucun document ne contribue à ce montant pour le moment.')}</p>}
    {rows.length>limit&&<Button variant="ghost" onClick={()=>setLimit(value=>value+20)}>{t('Afficher plus de documents')}</Button>}
  </section>;
}
