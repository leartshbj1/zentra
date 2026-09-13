// Development-only component fixture. No API calls or customer data.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { GettingStartedChecklist } from '../src/GettingStartedChecklist';
import { LanguageSetting } from '../src/LanguageSetting';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
import '../src/workspace-shell.css';
import '../src/guided-tour.css';
import '../src/clarity.css';
import '../src/refined.css';

const scenarios = ['empty','client','project','billing','quote-draft','quote-issued','quote-accepted','invoice-draft','invoice-issued','accounting','invoice-paid','payment','complete'];
function data(scenario: number) {
  const workspace = {
    clients: [], projects: [], quotes: [], invoices: [], payments: [], accountingSettings: null,
    backupStatus: { lastSuccessAt: null, lastPath: null, nextScheduledAt: null },
  } as unknown as Workspace;
  if(scenario>=1)workspace.clients=[{id:'customer-qa',name:'Client {name}',archivedAt:null}] as Workspace['clients'];
  if(scenario>=2)workspace.projects=[{id:'project-qa',clientId:'customer-qa',name:'Projet {year}',archivedAt:null}] as Workspace['projects'];
  if(scenario===3)workspace.settings={setupDeferred:{billing:true}} as Workspace['settings'];
  if(scenario>=4)workspace.quotes=[{id:'quote-qa',clientId:'customer-qa',number:scenario===4?'':'DEV-2026-QA',status:scenario===4?'draft':scenario===5?'issued':'accepted'}] as Workspace['quotes'];
  if(scenario>=7)workspace.invoices=[{id:'invoice-qa',clientId:'customer-qa',quoteId:'quote-qa',number:scenario===7?'':'FAC-2026-QA',type:'standard',status:scenario===7?'draft':scenario>=10?'paid':'issued'}] as Workspace['invoices'];
  if(scenario>=9)workspace.accountingSettings={enabled:true,arAccountId:'ar-qa',bankAccountId:'bank-qa'} as Workspace['accountingSettings'];
  if(scenario>=11)workspace.payments=[{invoiceId:'invoice-qa',amountCents:12500,journalEntryId:'journal-qa',journalEntryIsActive:true,journalEntrySemanticallyValid:true}] as Workspace['payments'];
  if(scenario===12)workspace.backupStatus={lastSuccessAt:'2026-09-13',lastPath:'QA archive {name}',nextScheduledAt:null};
  return workspace;
}
function Journey() {
  const [scenario,setScenario]=useState(0),[readOnly,setReadOnly]=useState(false),[compact,setCompact]=useState(false);
  return <main data-experience="clarity" style={{maxWidth:1200,margin:'auto',padding:16}}>
    <LanguageSetting compact />
    <div style={{display:'flex',flexWrap:'wrap',gap:12,marginBlock:20}}>
      <select aria-label="QA scenario" value={scenario} onChange={event=>setScenario(Number(event.target.value))}>{scenarios.map((name,index)=><option key={name} value={index}>{name}</option>)}</select>
      <label><input type="checkbox" data-read-only checked={readOnly} onChange={event=>setReadOnly(event.target.checked)}/> QA read-only</label>
      <label><input type="checkbox" data-compact checked={compact} onChange={event=>setCompact(event.target.checked)}/> QA compact</label>
    </div>
    <GettingStartedChecklist key={`${scenario}-${compact}`} workspace={data(scenario)} readOnly={readOnly} compact={compact} onAction={action=>{sessionStorage.setItem('qa-first-step-action',JSON.stringify(action));}} />
  </main>;
}
createRoot(document.getElementById('root')!).render(<Journey/>);
