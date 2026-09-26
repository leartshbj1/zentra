import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ScanLine, Check, X } from 'lucide-react';
import { Button, ErrorPanel } from './ui';
import { useCompanyAutomation } from './AutomationCompany';
import { featureReady } from './automation';
import { readInvoiceText, consistentScanAmounts, type InvoiceScan } from './invoiceScan';
import { errorMessage, formatMoney } from './utils';
import './invoice-scan.css';
import './projectFilePreview.css';
import { TouchImagePreview } from './TouchImagePreview';
const PdfPreview=lazy(()=>import('./PdfAttachmentPreview'));
function Original({file}:{file:File}){
  const [source,setSource]=useState<{bytes:Uint8Array;url:string}|null>(null),[failed,setFailed]=useState(false);
  useEffect(()=>{let live=true;const url=URL.createObjectURL(file);void file.arrayBuffer().then(buffer=>{if(live)setSource({bytes:new Uint8Array(buffer),url});}).catch(()=>{if(live)setFailed(true);});return()=>{live=false;URL.revokeObjectURL(url);};},[file]);
  if(failed)return <p>L’original ne peut pas être affiché ici. Vérifiez-le dans votre lecteur de documents.</p>;
  if(!source)return <p role="status">Ouverture de l’original…</p>;
  return <div className="invoice-scan__original">{/\.pdf$/i.test(file.name)?<Suspense fallback={<p>Ouverture du PDF…</p>}><PdfPreview bytes={source.bytes} name={file.name}/></Suspense>:<TouchImagePreview url={source.url} name={file.name} onError={()=>setFailed(true)}/>}</div>;
}

export function InvoiceScanPanel({disabled,onApply,onBusy}:{disabled:boolean;onApply:(scan:InvoiceScan,file:File)=>void;onBusy:(v:boolean)=>void}) {
  const company=useCompanyAutomation(), input=useRef<HTMLInputElement>(null), generation=useRef(0);
  const [busy,setBusy]=useState(false), [progress,setProgress]=useState(''), [error,setError]=useState('');
  const [result,setResult]=useState<{scan:InvoiceScan;file:File}|null>(null);
  useEffect(()=>()=>{generation.current++;},[]);
  if(!company.state || !featureReady(company.state,'supplier_routing')) return null;
  async function read(file:File){
    const ticket=++generation.current;
    setBusy(true);onBusy(true);setError('');setResult(null);setProgress('Ouverture du document…');
    try{
      const text=await readInvoiceText(file,value=>{if(ticket===generation.current)setProgress(value);});
      if(ticket!==generation.current)return;
      setProgress('Préparation de la facture…');
      const response=await invoke<{status:string;message?:string;extraction?:InvoiceScan}>('automation_request',{data:{action:'invoice_scan',requestId:crypto.randomUUID(),text}});
      if(ticket!==generation.current)return;
      if(response.status!=='suggestion'||!response.extraction)throw Error(response.message||'La lecture est indisponible. Vous pouvez remplir la facture.');
      setResult({scan:response.extraction,file});
    }catch(reason){if(ticket===generation.current)setError(errorMessage(reason,'La lecture n’a pas abouti.'));}
    finally{if(ticket===generation.current){setBusy(false);onBusy(false);}}
  }
  const scan=result?.scan;
  return <div className="invoice-scan" aria-busy={busy}>
    <div className="invoice-scan__start"><Button type="button" variant="secondary" disabled={disabled||busy} onClick={()=>input.current?.click()}><ScanLine size={18}/>{busy?progress:'Scanner une facture'}</Button><span>PDF ou photo · Automation prépare la saisie.</span></div>
    <input ref={input} type="file" accept=".pdf,.png,.jpg,.jpeg,.webp" hidden onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void read(file);}}/>
    <p className="sr-only" role="status">{busy?progress:''}</p>
    {scan&&result&&<section className="invoice-scan__review" aria-label="Informations lues sur la facture">
      <div className="invoice-scan__heading"><div><h4>{scan.supplierName||'Fournisseur à vérifier'}</h4><p>{result.file.name}</p></div><Button type="button" variant="ghost" aria-label="Fermer la proposition" onClick={()=>setResult(null)}><X size={18}/></Button></div>
      <dl>{[['Référence',scan.reference],['Date',scan.invoiceDate],['Échéance',scan.dueDate],['Total',scan.totalCents!==null?`${formatMoney(scan.totalCents)}${scan.currency!=='CHF'?` · devise lue : ${scan.currency||'inconnue'}`:''}`:null]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'À compléter'}</dd></div>)}</dl>
      {!consistentScanAmounts(scan)&&<p role="status">Les montants ou les taux ne concordent pas. Les lignes d’achat resteront à compléter.</p>}
      {scan.issues.length>0&&<details><summary>{scan.issues.length} points à vérifier</summary><ul>{scan.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></details>}
      <p>Comparez avec votre original. Il sera joint au brouillon lors de l’enregistrement.</p>
      <details className="invoice-scan__source"><summary>Voir le document original</summary><Original file={result.file}/></details>
      <Button type="button" disabled={disabled||scan.kind!=='supplier_invoice'||scan.currency!=='CHF'} onClick={()=>{onApply(scan,result.file);setResult(null);}}><Check size={17}/>Utiliser ces informations</Button>
    </section>}
    {error&&<ErrorPanel title="Lecture à reprendre" message={error}/>}
  </div>;
}
