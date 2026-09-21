import { lazy,Suspense,useEffect,useState } from 'react';
import { Inbox,ArrowRight,FileText,Check,Link2 } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Button,Field,Modal } from './ui';
import { t,useAppLanguage } from './language';
import type { Workspace } from './types';
import { inboxRequest,pendingMailInvoices,type MailInvoice,type useSupplierInbox } from './supplierInbox';
import { TouchImagePreview } from './TouchImagePreview';
import { inboxCategoryLabels as categoryLabels, mailboxInvoiceAmounts, mailboxInvoiceDefaults } from './supplierInboxReview';
import './SupplierInbox.css';
const PdfPreview=lazy(()=>import('./PdfAttachmentPreview'));
export function SupplierInbox({inbox,workspace,readOnly,onOpen,onNewSupplier}:{inbox:ReturnType<typeof useSupplierInbox>;workspace:Workspace;readOnly:boolean;onOpen:(id:string)=>void;onNewSupplier:()=>void}){
  useAppLanguage();
  const [open,setOpen]=useState(false),[selected,setSelected]=useState<MailInvoice|null>(null),[notice,setNotice]=useState('');
  useEffect(()=>{setSelected(null);setOpen(false);setNotice('');},[inbox.state?.organizationId]);
  const pending=pendingMailInvoices(inbox.state);
  const ready=inbox.state?.linked;
  return <section className="supplier-inbox">
    <header><span className="supplier-inbox__icon"><Inbox size={22}/></span><div><h2>{t('Boîte de réception fournisseurs')}{pending.length>0&&<span className="supplier-inbox__count">{pending.length}</span>}</h2><p>{t(ready?'Les factures de votre boîte mail, réunies pour toute l’équipe.':'Reliez votre boîte mail pour retrouver vos factures ici.')}</p></div><Button variant="secondary" onClick={()=>ready?setOpen(!open):void invoke('open_supplier_inbox_settings')}>{t(ready?(open?'Réduire':'Voir les factures'):'Relier Support')}<ArrowRight size={16}/></Button></header>
    {ready&&<div className="supplier-inbox__status"><Check size={14}/>{t(inbox.state?.autoPost?'Automation actif · les factures vérifiables sont comptabilisées à l’ouverture de Gestion.':'Vérification avant comptabilisation')}</div>}
    {inbox.error&&<p className="supplier-inbox__notice" role="status">{t(inbox.error)}</p>}
    {notice&&<p className="supplier-inbox__notice" role="status">{t(notice)}</p>}
    {open&&<div className="supplier-inbox__list">{inbox.state?.items.filter(i=>i.state!=='ignored').map(item=><article key={item.id}><FileText size={20}/><div><strong>{item.extraction.supplierName||item.sender||item.fileName}</strong><span>{item.extraction.reference||item.fileName}</span><small>{t(item.state==='imported'?(item.automatic?'Comptabilisée par Automation':'Enregistrée dans Gestion'):item.otherDevice?'Import en cours sur un autre appareil':'À vérifier')}</small></div><b>{item.extraction.totalCents!==null?new Intl.NumberFormat(undefined,{style:'currency',currency:item.extraction.currency||'CHF'}).format(item.extraction.totalCents/100):'—'}</b><Button variant="secondary" disabled={inbox.busy||item.otherDevice} onClick={()=>item.state==='imported'?onOpen(item.invoiceId||item.id):setSelected(item)}>{t(item.state==='imported'?'Ouvrir':'Vérifier')}</Button></article>)}{!inbox.state?.items.some(i=>i.state!=='ignored')&&<p>{t('Votre prochaine facture apparaîtra ici automatiquement.')}</p>}</div>}
    {open&&ready&&<Button variant="ghost" onClick={()=>void invoke('open_supplier_inbox_settings')}><Link2 size={15}/>{t('Réglages de la boîte mail')}</Button>}
    {selected&&<ReviewMailInvoice key={selected.id} item={selected} workspace={workspace} busy={inbox.busy} readOnly={readOnly} onClose={()=>setSelected(null)} onNewSupplier={()=>{setSelected(null);onNewSupplier();}} onIgnore={async()=>{await inboxRequest({action:'ignore',id:selected.id});setSelected(null);await inbox.refresh();}} onSave={async (draft,confirm)=>{const result=await inbox.importInvoice(selected,draft,confirm);setSelected(null);setNotice(result.posted?'Facture comptabilisée. Le justificatif est joint et les montants sont mis à jour.':'Brouillon enregistré avec son justificatif.');onOpen(result.id);}}/>}
  </section>;
}
function ReviewMailInvoice({item,workspace,busy,readOnly,onClose,onNewSupplier,onIgnore,onSave}:{item:MailInvoice;workspace:Workspace;busy:boolean;readOnly:boolean;onClose:()=>void;onNewSupplier:()=>void;onIgnore:()=>Promise<void>;onSave:(draft:import('./supplierInbox').InboxDraft,confirm:boolean)=>Promise<void>}){
  const e=item.extraction;
  const defaults=mailboxInvoiceDefaults(item,workspace);
  const [editing,setEditing]=useState(!defaults.supplierId||!e.reference||!e.invoiceDate||!e.dueDate||e.netCents===null||e.vatBp===null||!e.category||e.issues.length>0);
  const [posting,setPosting]=useState(false);
  const working=busy||posting;
  const [supplier,setSupplier]=useState(defaults.supplierId),[reference,setReference]=useState(e.reference||''),[date,setDate]=useState(e.invoiceDate||''),[due,setDue]=useState(e.dueDate||''),[net,setNet]=useState(e.netCents===null?'':(e.netCents/100).toFixed(2)),[vat,setVat]=useState(e.vatBp===null?'':String(e.vatBp/100)),[category,setCategory]=useState(categoryLabels[e.category||'']||defaults.category),[account,setAccount]=useState(defaults.accountId),[error,setError]=useState(''),[source,setSource]=useState<{bytes:Uint8Array;url:string}|null>(null),[documentError,setDocumentError]=useState('');
  useEffect(()=>{let alive=true,url='';void inboxRequest<{base64:string}>({action:'document',id:item.id}).then(result=>{if(!alive)return;const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));url=URL.createObjectURL(new Blob([bytes],{type:item.mediaType}));setSource({bytes,url});}).catch(()=>{if(alive)setDocumentError('Le justificatif ne peut pas être chargé. Fermez puis rouvrez cette facture.');});return()=>{alive=false;if(url)URL.revokeObjectURL(url);};},[item.id,item.mediaType]);
  const amounts=mailboxInvoiceAmounts(net,vat);
  const total=amounts?.totalCents;
  const confirmInvoice=async(confirm:boolean)=>{
    setError('');
    if(working||readOnly)return;
    if(!source){setError('Attendez le chargement du justificatif.');return;}
    if(e.currency&&e.currency!=='CHF'){setError('Cette facture nécessite une conversion en CHF et une saisie manuelle. Conservez le justificatif.');return;}
    if(!amounts){setEditing(true);setError('Recopiez le montant hors taxe et le taux de TVA du justificatif.');return;}
    if(!supplier||!reference.trim()||!date||!due||!category){setEditing(true);setError('Complétez les informations manquantes ci-dessous.');return;}
    setPosting(true);
    try{await onSave({supplier_id:supplier,date,due_date:due,reference,items:[{description:`Facture ${reference}`,quantity_milli:1000,unit_price_cents:amounts.netCents,vat_bp:amounts.vatBp,category,expense_account_id:account||null}]},confirm);}
    catch(reason){setEditing(true);setError(String(reason instanceof Error?reason.message:reason));}
    finally{setPosting(false);}
  };
  return <Modal title={t('Votre facture est préparée')} onClose={onClose} dismissible={!working} wide className="supplier-inbox-review"><form onInvalid={()=>setEditing(true)} onSubmit={event=>{event.preventDefault();void confirmInvoice(true);}}>
    <div className="supplier-inbox-review__summary"><div><span>{t('Fournisseur')}</span><strong>{workspace.suppliers.find(s=>s.id===supplier)?.name||e.supplierName||item.sender}</strong><p>{reference||t('Référence à compléter')} · {category||t('Catégorie à compléter')}</p></div><strong>{total!==undefined?(total/100).toFixed(2):'—'} CHF</strong></div>
    <p className="supplier-inbox-review__intro">{t('Vérifiez le justificatif, puis confirmez. Zentra enregistrera la facture et son écriture comptable ensemble. Aucun paiement ne sera envoyé.')}</p>
    <div className="supplier-inbox-review__grid"><div className="supplier-inbox-review__document">{source?<Suspense fallback={<p>{t('Ouverture du document…')}</p>}>{item.mediaType==='application/pdf'?<PdfPreview bytes={source.bytes} name={item.fileName}/>:<TouchImagePreview url={source.url} name={item.fileName} onError={()=>setDocumentError('Cette image ne peut pas être affichée.')}/>}</Suspense>:<p>{t(documentError||'Chargement du justificatif…')}</p>}</div><fieldset disabled={working||readOnly}><details className="supplier-inbox-review__fields" open={editing} onToggle={event=>setEditing(event.currentTarget.open)}><summary>{t(editing?'Informations et classement':'Modifier les informations')}</summary><div>
    <Field label={t('Fournisseur')}><select required value={supplier} onChange={event=>setSupplier(event.target.value)}><option value="">{t('Choisir un fournisseur')}</option>{workspace.suppliers.filter(s=>!s.archivedAt).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Button type="button" variant="ghost" onClick={onNewSupplier}>{t('Ajouter un fournisseur')}</Button>
    <Field label={t('Référence')}><input required maxLength={200} value={reference} onChange={event=>setReference(event.target.value)}/></Field>
    <div className="supplier-inbox-review__dates"><Field label={t('Date de facture')}><input type="date" required value={date} onChange={event=>setDate(event.target.value)}/></Field><Field label={t('Échéance')}><input type="date" required min={date} value={due} onChange={event=>setDue(event.target.value)}/></Field></div>
    <div className="supplier-inbox-review__dates"><Field label={t('Hors taxe (CHF)')}><input inputMode="decimal" required value={net} onChange={event=>setNet(event.target.value)}/></Field><Field label={t('TVA (%)')}><input inputMode="decimal" required value={vat} onChange={event=>setVat(event.target.value)}/></Field></div>
    <Field label={t('Catégorie')}><select required value={category} onChange={event=>setCategory(event.target.value)}><option value="">{t('Choisir une catégorie')}</option>{[...new Set([...Object.values(categoryLabels),defaults.category].filter(Boolean))].map(c=><option key={c} value={c}>{t(c)}</option>)}</select></Field>
    <Field label={t('Compte de charges')}><select value={account} onChange={event=>setAccount(event.target.value)}><option value="">{t('Compte par défaut de l’entreprise')}</option>{workspace.accounts.filter(a=>a.active&&a.accountType==='expense').map(a=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>
    <div className="supplier-inbox-review__total"><span>{t('Total')}</span><strong>{total!==undefined?(total/100).toFixed(2):'—'} CHF</strong></div>
    {e.issues.length>0&&<details><summary>{t('Points à vérifier')}</summary><ul>{e.issues.map((issue,i)=><li key={i}>{t(issue)}</li>)}</ul></details>}
    </div></details></fieldset></div>{error&&<p role="alert" className="supplier-inbox__notice">{t(error)}</p>}<footer><Button type="button" variant="ghost" disabled={working||readOnly} onClick={()=>{setPosting(true);void onIgnore().catch(reason=>setError(String(reason))).finally(()=>setPosting(false));}}>{t('Ce n’est pas une facture')}</Button><div><Button type="button" variant="secondary" disabled={working||readOnly||!source} onClick={()=>void confirmInvoice(false)}>{t('Garder en brouillon')}</Button><Button type="submit" disabled={working||readOnly||!source}>{t(working?'Enregistrement…':'Confirmer et comptabiliser')}<Check size={16}/></Button></div></footer></form></Modal>;
}
