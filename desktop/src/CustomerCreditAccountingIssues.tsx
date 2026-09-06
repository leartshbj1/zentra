import { useState } from 'react';
import { BookOpen, ChevronDown, ShieldAlert } from 'lucide-react';
import type { CustomerCreditAccountingIssue } from './types';
import { Button } from './ui';
import { formatDate } from './utils';
import './CustomerCreditAccountingIssues.css';

const labels: Record<CustomerCreditAccountingIssue['kind'], string> = {missing_posting:'À comptabiliser',invalid_posting:'Preuve à vérifier',orphan_journal:'Écriture sans lien fiable',bank_refund_proof:'Preuve bancaire à vérifier'};

export function CustomerCreditAccountingIssues({issues=[],busy,onOpenJournal}: {
  issues?:CustomerCreditAccountingIssue[];busy:boolean;onOpenJournal:(id:string)=>void;
}) {
  const [visible,setVisible]=useState(8);
  if(!issues.length)return null;
  const ordered=[...issues].sort((a,b)=>b.date.localeCompare(a.date)||(a.settlementId??a.journalEntryId??'').localeCompare(b.settlementId??b.journalEntryId??''));
  return <details className="customer-credit-checks">
    <summary><ShieldAlert size={20}/><span>Contrôles des avoirs clients <small>{issues.length} point{issues.length>1?'s':''} à vérifier</small></span><ChevronDown size={18}/></summary>
    <div className="customer-credit-checks__body">
      <p>Retrouvez les règlements concernés avant de poursuivre la clôture. Les montants et les dates restent conservés.</p>
      <ol aria-label="Anomalies des règlements clients">{ordered.slice(0,visible).map((issue)=><li key={`${issue.kind}:${issue.creditNoteId}:${issue.settlementId}:${issue.journalEntryId}`}>
        <div className="customer-credit-checks__identity"><strong>{issue.creditNoteNumber||issue.journalNumber||'Règlement client'}</strong><span>{formatDate(issue.date)}</span></div>
        <span className="customer-credit-checks__state">{issue.kind==='missing_posting'&&issue.closedPeriod?'Reprise historique à valider':labels[issue.kind]||'À vérifier'}</span>
        {issue.reference&&<p>{issue.reference}</p>}
        <p>{issue.reason}</p>
        {issue.closedPeriod&&<small>Cette opération appartient à l’historique clôturé.</small>}
        {issue.journalEntryId&&issue.journalAvailable&&<Button variant="secondary" size="small" disabled={busy} onClick={()=>onOpenJournal(issue.journalEntryId!)} aria-label={`Voir l’écriture de ${issue.creditNoteNumber||issue.journalNumber||'ce règlement'}`}><BookOpen size={16}/>Voir l’écriture</Button>}
      </li>)}</ol>
      {visible<issues.length&&<Button variant="ghost" disabled={busy} onClick={()=>setVisible(value=>value+8)}>Afficher les {Math.min(8,issues.length-visible)} suivants</Button>}
    </div>
  </details>;
}
