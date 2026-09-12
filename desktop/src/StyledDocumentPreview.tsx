import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import { desktopApi } from './bridge';
import { Button, ErrorPanel, Modal } from './ui';
import PdfAttachmentPreview from './PdfAttachmentPreview';
import { errorMessage } from './utils';
import { isMobileRuntime, shareMobileExport } from './mobileRuntime';
import './projectFilePreview.css';

export default function StyledDocumentPreview({ kind, id, title, onClose }: { kind:'quotes'|'invoices'|'payslips'; id:string; title:string; onClose:()=>void }) {
  const [bytes,setBytes]=useState<Uint8Array|null>(null), [error,setError]=useState(''), [attempt,setAttempt]=useState(0);
  const [exporting,setExporting]=useState(false), [exportError,setExportError]=useState(''), [notice,setNotice]=useState('');
  const flight=useRef(false);
  const [exportedPath,setExportedPath]=useState('');
  useEffect(()=>{let active=true;setError('');setBytes(null);void desktopApi.documentPdfPreview(kind,id).then(data=>{if(active)setBytes(new Uint8Array(data));}).catch(reason=>{if(active)setError(errorMessage(reason,'Le PDF ne peut pas être affiché. Réessayez.'));});return()=>{active=false;};},[kind,id,attempt]);
  async function exportPdf(){if(flight.current)return;flight.current=true;setExporting(true);setExportError('');setNotice('');try{
    const result=kind==='payslips'?await desktopApi.exportPayslipPdf(id,`${title}.pdf`):await desktopApi.exportSalesDocumentPdf(kind,id,`${title}.pdf`);
    if(result){ setExportedPath(result.path); setNotice('deliveryWarning' in result && result.deliveryWarning ? String(result.deliveryWarning) : 'Le PDF a été créé avec cette présentation.'); }
  }catch(reason){setExportError(errorMessage(reason,'L’export a échoué. Réessayez.'));}finally{flight.current=false;setExporting(false);}}
  async function share(){ if(flight.current || !exportedPath)return;flight.current=true;setExporting(true);setExportError('');try{await shareMobileExport(exportedPath);setNotice('Partage du PDF ouvert.');}catch(reason){setExportError(errorMessage(reason,'Le partage a échoué. Le PDF est déjà créé : réessayez le partage.'));}finally{flight.current=false;setExporting(false);}}
  return <Modal title={title} description="Votre document avec sa présentation enregistrée. Le PDF exporté utilise ce même rendu." onClose={onClose} dismissible={!exporting} wide className="attachment-preview-dialog">
    <div className="attachment-preview"><div className="attachment-preview__content">
      {error?<ErrorPanel message={error} onRetry={()=>setAttempt(n=>n+1)} />:bytes?<PdfAttachmentPreview bytes={bytes} name={title} />:<p role="status" className="attachment-preview__status">Préparation des pages…</p>}
    </div><footer className="attachment-preview__footer">{exportError&&<ErrorPanel message={exportError} />}{notice&&<p role="status">{notice}</p>}<div className="attachment-preview__actions"><Button disabled={!bytes||exporting} onClick={()=>void exportPdf()}><Download size={17} />{exporting?'Création du PDF…':'Exporter le PDF'}</Button><Button variant="secondary" disabled={exporting} onClick={onClose}>Fermer</Button>{exportedPath && isMobileRuntime() && <Button variant="secondary" disabled={exporting} onClick={()=>void share()}>Partager le PDF</Button>}</div></footer></div>
  </Modal>;
}
