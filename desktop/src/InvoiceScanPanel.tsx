import { withDiagnosticIntent } from './diagnosticIntent';
import { lazy, Suspense, useLayoutEffect, useRef, useState } from 'react';
import { diagnosticInvoke as invoke } from './diagnostics';
import { ScanLine, Check, X } from 'lucide-react';
import { Button, ErrorPanel } from './ui';
import { useCompanyAutomation } from './AutomationCompany';
import { featureReady } from './automation';
import { readInvoiceText, consistentScanAmounts, type InvoiceScan } from './invoiceScan';
import { errorMessage } from './utils';
import './invoice-scan.css';
import './projectFilePreview.css';
import { TouchImagePreview } from './TouchImagePreview';
const PdfPreview=lazy(()=>import('./PdfAttachmentPreview'));
function Original({file}:{file:File}){
  const [source,setSource]=useState<{bytes:Uint8Array;url:string}|null>(null),[failed,setFailed]=useState(false);
  useLayoutEffect(()=>{let live=true;const url=URL.createObjectURL(file);void file.arrayBuffer().then(buffer=>{if(live)setSource({bytes:new Uint8Array(buffer),url});}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;URL.revokeObjectURL(url);};},[file]);
  if(failed)return <p>L’original ne peut pas être affiché ici. Vérifiez-le dans votre lecteur de documents.</p>;
  if(!source)return <p role="status">Ouverture de l’original…</p>;
  return <div className="invoice-scan__original">{/\.pdf$/i.test(file.name)?<Suspense fallback={<p>Ouverture du PDF…</p>}><PdfPreview bytes={source.bytes} name={file.name}/></Suspense>:<TouchImagePreview url={source.url} name={file.name} onError={()=>setFailed(true)}/>}</div>;
}

export function InvoiceScanPanel({disabled,onApply,onBusy}:{disabled:boolean;onApply:(scan:InvoiceScan,file:File,text:string)=>void;onBusy:(v:boolean)=>void}) {
  const company=useCompanyAutomation(), input=useRef<HTMLInputElement>(null), generation=useRef(0);
  const [busy,setBusy]=useState(false), [progress,setProgress]=useState(''), [error,setError]=useState('');
  const [result,setResult]=useState<{scan:InvoiceScan;file:File;text:string;ticket:number;organizationId:string|null}|null>(null);
  const active=Boolean(company.state && featureReady(company.state,'supplier_routing'));
  const mounted=useRef(false), running=useRef<number|null>(null);
  const current=useRef({disabled,onApply,onBusy,organizationId:company.organizationId,readOnly:company.readOnly,active});
  current.current={disabled,onApply,onBusy,organizationId:company.organizationId,readOnly:company.readOnly,active};
  useLayoutEffect(()=>{mounted.current=true;generation.current++;running.current=null;setResult(null);setError('');setBusy(false);current.current.onBusy(false);return()=>{mounted.current=false;generation.current++;running.current=null;current.current.onBusy(false);};},[company.organizationId,company.readOnly,active]);
  const isCurrent=(ticket:number,organizationId:string|null)=>mounted.current&&ticket===generation.current&&current.current.organizationId===organizationId&&current.current.active;
  const mayRead=(ticket:number,organizationId:string|null)=>isCurrent(ticket,organizationId)&&!current.current.readOnly;
  if(!active) return null;
  async function read(file:File){
    if(!mounted.current||running.current!==null||current.current.disabled||current.current.readOnly||!current.current.active)return;
    const ticket=++generation.current;
    const organizationId=current.current.organizationId;
    running.current=ticket;
    setBusy(true);setError('');setResult(null);setProgress('Ouverture du document…');current.current.onBusy(true);
    try{
      if(!mayRead(ticket,organizationId))return;
      const text=await readInvoiceText(file,value=>{if(mayRead(ticket,organizationId))setProgress(value);});
      if(!mayRead(ticket,organizationId))return;
      setProgress('Préparation de la facture…');
      const response=await invoke<{status:string;message?:string;extraction?:InvoiceScan}>('automation_request',withDiagnosticIntent({data:{action:'invoice_scan',requestId:crypto.randomUUID(),text}}, 'automation_request', 'invoice_scan'));
      if(!mayRead(ticket,organizationId))return;
      if(response.status!=='suggestion'||!response.extraction)throw Error(response.message||'La lecture est indisponible. Vous pouvez remplir la facture.');
      setResult({scan:response.extraction,file,text,ticket,organizationId});
    }catch(reason){if(mayRead(ticket,organizationId))setError(errorMessage(reason,'La lecture n’a pas abouti.'));}
    finally{if(running.current===ticket)running.current=null;if(isCurrent(ticket,organizationId)){setBusy(false);current.current.onBusy(false);}}
  }
  function apply(){
    if(!result||!mayRead(result.ticket,result.organizationId)||current.current.disabled||result.scan.kind!=='supplier_invoice'||result.scan.currency!=='CHF')return;
    const ticket=++generation.current;
    current.current.onApply(result.scan,result.file,result.text);
    if(isCurrent(ticket,result.organizationId))setResult(null);
  }
  function dismiss(){
    if(!result||!isCurrent(result.ticket,result.organizationId))return;
    generation.current++;setResult(null);
  }
  const scan=result?.scan;
  return <div className="invoice-scan" aria-busy={busy}>
    <div className="invoice-scan__start"><Button type="button" variant="secondary" disabled={disabled||company.readOnly||busy} onClick={()=>input.current?.click()}><ScanLine size={18}/>{busy?progress:'Scanner une facture'}</Button><span>PDF ou photo · Automation prépare la saisie.</span></div>
    <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" hidden onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void read(file);}}/>
    <p className="sr-only" role="status">{busy?progress:''}</p>
    {scan&&result&&<section className="invoice-scan__review" aria-label="Informations lues sur la facture">
      <div className="invoice-scan__heading"><div><h4>{scan.supplierName||'Fournisseur à vérifier'}</h4><p>{result.file.name}</p></div><Button type="button" variant="ghost" aria-label="Fermer la proposition" onClick={dismiss}><X size={18}/></Button></div>
      <dl>{[['Référence',scan.reference],['Date',scan.invoiceDate],['Échéance',scan.dueDate],['Total',scan.totalCents!==null?`${new Intl.NumberFormat('fr-CH',{minimumFractionDigits:2,maximumFractionDigits:2}).format(scan.totalCents/100)} ${scan.currency||'(devise à vérifier)'}`:null]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'À compléter'}</dd></div>)}</dl>
      {!consistentScanAmounts(scan)&&<p role="status">Les montants ou les taux ne concordent pas. Les lignes d’achat resteront à compléter.</p>}
      {scan.issues.length>0&&<details><summary>{scan.issues.length} points à vérifier</summary><ul>{scan.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></details>}
      <p>Comparez avec votre original. Il sera joint au brouillon lors de l’enregistrement.</p>
      <details className="invoice-scan__source"><summary>Voir le document original</summary><Original file={result.file}/></details>
      <Button type="button" disabled={disabled||company.readOnly||scan.kind!=='supplier_invoice'||scan.currency!=='CHF'} onClick={apply}><Check size={17}/>Utiliser ces informations</Button>
    </section>}
    {error&&<ErrorPanel title="Lecture à reprendre" message={error}/>}
  </div>;
}
