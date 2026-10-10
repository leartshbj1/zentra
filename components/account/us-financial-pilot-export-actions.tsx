'use client';

import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { SiteLanguage } from '@/lib/site-language';
import { browserUsFinancialPilotCopy } from '@/lib/international/browser-us-financial-pilot-copy';
import { browserUsFinancialPilotExportCopy, browserUsFinancialPilotExportErrorCopy } from '@/lib/international/browser-us-financial-pilot-export-copy';
import { createBrowserUsFinancialPilotExportSession, type BrowserUsFinancialPilotExportSession, BrowserUsFinancialPilotExportError } from '@/lib/international/browser-us-financial-pilot-export-session';
import type { UsFinancialPilotExportSelector } from '@/lib/international/us-financial-pilot-export-contract';
import type { BrowserUsFinancialPilotSession } from '@/lib/international/browser-us-financial-pilot-session';

type ReportType='trial_balance'|'profit_loss'|'balance_sheet'|'cash_flow'|'general_ledger'|'receivables';
type Document={kind:'invoice';invoiceId:string}|{kind:'estimate';estimateId:string;estimateRevision:number}|{kind:'report';from:string;to:string;asOf:string;accountId:string|null;cashFlowAvailable:boolean};
interface Props {organizationId:string;expectedUserId:string;revision:number;language:SiteLanguage;document:Document;onDenied:()=>void;financialSession?:Pick<BrowserUsFinancialPilotSession,'getState'|'subscribe'>;disabled?:boolean}
/** The parent keys this task by revision and document/range. A change unmounts
 * its owned download session, preventing late files from another selection. */
export function UsFinancialPilotExportActions({organizationId,expectedUserId,revision,language,document,onDenied,financialSession,disabled=false}:Props){
  const c=browserUsFinancialPilotExportCopy[language],labels=browserUsFinancialPilotCopy[language];
  const session=useRef<BrowserUsFinancialPilotExportSession|null>(null),generation=useRef(0),deniedCallback=useRef(onDenied),flight=useRef(false);
  const [reportType,setReportType]=useState<ReportType>('trial_balance'),[format,setFormat]=useState<'pdf'|'csv'>('pdf');
  const [busy,setBusy]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState('');
  const feedbackContext=useMemo(()=>({ownerProvided:Boolean(financialSession)}),[financialSession]);
  const [feedbackToken,setFeedbackToken]=useState<object|null>(null);
  const ownsFeedback=feedbackToken===feedbackContext,shownBusy=ownsFeedback&&busy;
  useLayoutEffect(()=>{deniedCallback.current=onDenied;},[onDenied]);
  useLayoutEffect(()=>{
    const ownedGeneration=generation.current;
    const active=createBrowserUsFinancialPilotExportSession({organizationId,expectedUserId,...(financialSession?{financialSession}:{})});session.current=active;
    return()=>{generation.current=ownedGeneration+1;session.current=null;flight.current=false;active.dispose();};
  },[organizationId,expectedUserId,financialSession]);
  async function download(){
    const active=session.current;if(!active||flight.current||disabled)return;const at=generation.current;
    let selector:UsFinancialPilotExportSelector;
    if(document.kind==='invoice')selector={kind:'invoice',invoiceId:document.invoiceId,revision,language,format:'pdf'};
    else if(document.kind==='estimate')selector={kind:'estimate',estimateId:document.estimateId,estimateRevision:document.estimateRevision,revision,language,format:'pdf'};
    else {
      const base={kind:'report' as const,revision,language,format};
      if(reportType==='receivables')selector={...base,reportType};
      else if(reportType==='trial_balance'||reportType==='balance_sheet')selector={...base,reportType,asOf:document.asOf};
      else if(reportType==='general_ledger'){
        if(!document.accountId)return;selector={...base,reportType,from:document.from,to:document.to,accountId:document.accountId};
      }else selector={...base,reportType,from:document.from,to:document.to};
    }
    flight.current=true;setFeedbackToken(feedbackContext);setBusy(true);setNotice('');setError('');
    try{
      const result=await active.file(selector);if(at!==generation.current)return;
      active.download(result);setNotice(c.ready);
    }catch(caught){
      if(at!==generation.current)return;
      const failure=caught instanceof BrowserUsFinancialPilotExportError?caught:null;
      setError(browserUsFinancialPilotExportErrorCopy(language,failure?.code??'',document.kind));
      if(failure?.unauthorized)deniedCallback.current();
    }finally{if(at===generation.current){flight.current=false;setBusy(false);}}
  }
  const reports=[
    {value:'trial_balance',label:labels.trial},{value:'profit_loss',label:labels.profit},{value:'balance_sheet',label:labels.balance},
    ...(document.kind==='report'&&document.cashFlowAvailable?[{value:'cash_flow',label:labels.cash}]:[]),
    {value:'receivables',label:labels.currentReceivables},
    ...(document.kind==='report'&&document.accountId?[{value:'general_ledger',label:labels.generalLedger}]:[]),
  ];
  return <div className="fp-export-task">
    <div className="fp-export-actions">
      {document.kind==='report'&&<><label>{c.report}<select disabled={shownBusy} value={reportType} onChange={event=>{setReportType(event.target.value as ReportType);setNotice('');setError('');}}>{reports.map(report=><option value={report.value} key={report.value}>{report.label}</option>)}</select></label><label>{c.format}<select disabled={shownBusy} value={format} onChange={event=>{setFormat(event.target.value as 'pdf'|'csv');setNotice('');setError('');}}><option value="pdf">PDF</option><option value="csv">CSV</option></select></label></>}
      <button className="account-button secondary" type="button" disabled={shownBusy||disabled} onClick={()=>{void download();}}><Download size={18} aria-hidden/>{shownBusy?c.preparing:document.kind==='invoice'?c.invoicePdf:document.kind==='estimate'?c.estimatePdf:c.download}</button>
    </div>
    {document.kind==='estimate'&&<p className="fp-context">{c.identityCurrent}</p>}
    <p className="fp-export-feedback" role={ownsFeedback&&error?'alert':'status'} aria-live="polite">{ownsFeedback?(error||notice):''}</p>
  </div>;
}
