import { ErrorDetails as SharedErrorDetails } from './ErrorGuidance';
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, CheckCircle2, PackageCheck, RefreshCw } from 'lucide-react';
import type { SupplierOrder, SupplierReceipt, Workspace } from './types';
import type { desktopApi } from './bridge';
import { formatCatalogQuantity, MAX_STOCK_QUANTITY_MILLI } from './catalog';
import { supplierOrderLineProgress } from './purchaseOrderFlow';
import { receiptDraft, receiptDraftLines, receiptFormIssue, receiptIssueProblems, receiptNativeIssue, receiptQuantityInput, receiptReverseProblems, receiptStockEffects, requireReceiptWorkspace, type ReceiptIssue } from './receiptWorkflow';
import { Button, Field, Modal } from './ui';
import { createId, errorMessage, formatDate, todayIso } from './utils';
import { t, useAppLanguage } from './language';
import './supplier-receipt.css';

type Shared = { workspace: Workspace; busy: boolean; readOnly: boolean; actionError: string; onClose: () => void; onReadWorkspace: () => Promise<Workspace> };
const orderLabel = (order?: SupplierOrder) => order?.number || order?.title || t('Commande fournisseur');

function focusReceiptProblem(target: HTMLElement | null) {
  if (!target) return;
  const details = target.closest('details'); if (details) details.open = true;
  target.focus({ preventScroll:true });
  const body = target.closest<HTMLElement>('.modal__body'), modal = target.closest<HTMLElement>('.modal');
  if (!body) return;
  const scroller = body.scrollHeight > body.clientHeight + 1 ? body : modal || body;
  const top = Math.max(0, scroller.getBoundingClientRect().top, modal?.querySelector('.modal__header')?.getBoundingClientRect().bottom || 0) + 12;
  const area = target.closest<HTMLElement>('.field, .receipt-check') || target;
  // Keep the beginning of a long explanation visible below the fixed heading.
  scroller.scrollTop += area.getBoundingClientRect().top - top;
}

function ReceiptSteps({ review }: { review?: boolean }) {
  useAppLanguage();
  return <ol className="receipt-steps" aria-label={t('Étapes de la réception')}><li aria-current={!review ? 'step' : undefined}><span>{review ? <CheckCircle2 size={17} /> : '1'}</span>{t('Ce qui est arrivé')}</li><li aria-current={review ? 'step' : undefined}><span>2</span>{t('Vérifier et valider')}</li></ol>;
}
function ErrorDetails({ message }: { message: string }) { return message ? <SharedErrorDetails error={message} /> : null; }

export function SupplierReceiptForm({ workspace, order: openedOrder, receipt: openedReceipt, busy, readOnly, actionError, onClose, onSave, onReadWorkspace }: Shared & { order: SupplierOrder; receipt?: SupplierReceipt; onSave: (input: Parameters<typeof desktopApi.saveSupplierReceiptDraft>[0]) => Promise<boolean> }) {
  useAppLanguage();
  const [id] = useState(() => openedReceipt?.id || createId());
  const order = workspace.supplierOrders.find(row => row.id === openedOrder.id);
  const current = openedReceipt ? workspace.supplierReceipts.find(row => row.id === id) : undefined;
  const [baseline, setBaseline] = useState(openedReceipt);
  const [draft, setDraft] = useState(() => receiptDraft(order, openedReceipt));
  const [issue, setIssue] = useState<ReceiptIssue | null>(null), [failure, setFailure] = useState(''), [hideActionError, setHideActionError] = useState(false);
  const [working, setWorking] = useState(false), flight = useRef(false), form = useRef<HTMLFormElement>(null), alert = useRef<HTMLDivElement>(null);
  const locked = busy || working;
  const unavailable = !!openedReceipt && (!current || current.status !== 'draft');
  const changed = !!current && current.updatedAt !== baseline?.updatedAt;
  const nativeIssue = !hideActionError && actionError ? receiptNativeIssue(actionError, order) : null;
  const shownIssue = issue || nativeIssue;
  const shownFailure = failure || (!hideActionError && actionError ? nativeIssue?.message || t('L’enregistrement n’a pas abouti. Vos quantités restent présentes. Actualisez les données puis réessayez.') : '');
  const eligible = order?.lines.filter(line => line.fulfillmentMode !== 'direct') || [];
  useEffect(() => {
    if (locked) return;
    const target = shownIssue && shownIssue.field !== 'record' ? form.current?.elements.namedItem(shownIssue.field === 'quantity' ? `quantity-${shownIssue.lineId}` : shownIssue.field) : changed || unavailable || shownFailure || shownIssue ? alert.current : null;
    if (!(target instanceof HTMLElement)) return;
    focusReceiptProblem(target);
  }, [locked, shownIssue?.field, shownIssue?.lineId, shownIssue?.message, shownFailure, changed, unavailable]);
  function edit(patch: Partial<typeof draft>) {
    if (locked || readOnly || changed || unavailable) return;
    setDraft(value => ({ ...value, ...patch })); setIssue(null); setFailure(''); setHideActionError(true);
  }
  async function refresh() {
    if (locked || flight.current) return;
    flight.current = true; setWorking(true); setFailure('');
    try { requireReceiptWorkspace(await onReadWorkspace()); }
    catch (reason) { setFailure(errorMessage(reason, t('Impossible de relire les réceptions. Réessayez.'))); }
    finally { flight.current = false; setWorking(false); }
  }
  async function submit() {
    if (locked || readOnly || flight.current) return;
    setHideActionError(true); setFailure('');
    const problem = unavailable || changed ? { field:'record' as const, message:unavailable ? t('Ce brouillon n’est plus modifiable. Actualisez son état ou revenez aux réceptions.') : t('Comparez les deux versions avant de continuer.') } : receiptFormIssue(draft, order, workspace);
    setIssue(problem); if (problem || !order) return;
    flight.current = true; setWorking(true); setHideActionError(false);
    try { await onSave({ id, ...(baseline ? {expectedUpdatedAt:baseline.updatedAt} : {}), supplierOrderId:order.id, receiptDate:draft.date, reference:draft.reference, notes:draft.notes, lines:receiptDraftLines(draft, order) }); }
    catch (reason) { setFailure(errorMessage(reason, t('Le brouillon n’a pas pu être enregistré. Votre saisie est conservée.'))); }
    finally { flight.current = false; setWorking(false); }
  }
  const nowDraft = receiptDraft(order, current);
  return <Modal wide className="supplier-receipt-modal" title={openedReceipt ? t('Modifier la réception') : t('Saisir une réception')} description={t('Indiquez la date et les quantités réellement reçues. Le reste pourra arriver plus tard.')} onClose={onClose} dismissible={!locked}>
    <ReceiptSteps />
    <form ref={form} className="receipt-form" noValidate onSubmit={e=>{e.preventDefault(); void submit();}}>
      <div className="receipt-context"><strong>{orderLabel(order)}</strong><span>{workspace.suppliers.find(row=>row.id===order?.supplierId)?.name || t('Fournisseur')}</span><small>{t('Le brouillon prépare la réception. Le stock change seulement après la validation à l’étape 2.')}</small></div>
      {(changed || unavailable || shownFailure || shownIssue?.field === 'record') && <div className="receipt-alert" role="alert" ref={alert} tabIndex={-1}>
        <strong>{unavailable ? t('Vérifions l’état de cette réception') : changed ? t('Cette réception a changé ailleurs') : t('Un point à vérifier')}</strong>
        {unavailable ? <p>{t('Le brouillon a été validé, annulé ou n’est plus accessible. Votre saisie reste affichée, sans nouvel enregistrement.')}</p> : changed ? <>
          <p>{t('Comparez les données actuelles et votre saisie. Choisir une version ne l’enregistre pas encore.')}</p>
          <div className="receipt-comparison"><div><strong>{t('Information')}</strong><strong>{t('Votre saisie')}</strong><strong>{t('Version actuelle')}</strong></div>
            {([[t('Date'),draft.date,nowDraft.date],[t('Référence'),draft.reference,nowDraft.reference],[t('Notes'),draft.notes,nowDraft.notes], ...eligible.map(line=>[line.description,draft.quantities[line.id] || '0',nowDraft.quantities[line.id] || '0'])]).filter(([,a,b])=>a!==b).map(([label,a,b],index)=><div key={index}><span>{label}</span><span>{a || t('Non renseigné')}</span><span>{b || t('Non renseigné')}</span></div>)}
          </div>
          <div className="receipt-inline-actions"><Button type="button" variant="secondary" disabled={locked || readOnly} onClick={()=>{setBaseline(current);setIssue(null);setHideActionError(true);}}>{t('Conserver ma saisie')}</Button><Button type="button" variant="secondary" disabled={locked} onClick={()=>{setBaseline(current);setDraft(nowDraft);setIssue(null);setHideActionError(true);}}>{t('Utiliser la version actuelle')}</Button></div>
        </> : <p>{t(shownIssue?.field==='record' ? shownIssue.message : shownFailure)}</p>}
        {!hideActionError && <ErrorDetails message={actionError} />}
        <Button type="button" variant="secondary" disabled={locked} onClick={()=>void refresh()}><RefreshCw size={16} /> {t('Actualiser les réceptions')}</Button>
      </div>}
      {readOnly && <p className="receipt-note" role="status">{t('Vous pouvez consulter et actualiser cette réception. L’enregistrement est indisponible en lecture seule.')}</p>}
      <fieldset disabled={locked || readOnly || changed || unavailable}>
        <Field label={t('Date de réception')} required hint={t('Le jour où les marchandises sont réellement arrivées.')} error={shownIssue?.field==='date' ? t(shownIssue.message) : undefined}><input name="date" type="date" min={order?.orderDate} max={todayIso()} value={draft.date} onChange={e=>edit({date:e.target.value})} /></Field>
        <div className="receipt-quantity-heading"><div><h3>{t('Qu’avez-vous reçu ?')}</h3><p>{t('Mettez 0 pour les articles absents de cette livraison.')}</p></div><Button type="button" variant="secondary" onClick={()=>edit({quantities:{...draft.quantities,...Object.fromEntries(eligible.map(line=>[line.id,receiptQuantityInput(supplierOrderLineProgress(order!,line,workspace).remainingToReceiveMilli)]))}})}>{t('Tout est arrivé')}</Button></div>
        {eligible.map(line=>{ const remaining=supplierOrderLineProgress(order!,line,workspace).remainingToReceiveMilli; return <article className="receipt-quantity" key={line.id}>
          <div><strong>{line.description}</strong><small>{t('Il reste {quantity} {unit} à recevoir.', { quantity: formatCatalogQuantity(remaining), unit: line.unit })}</small><small>{line.fulfillmentMode==='stocked_receipt' ? t('Ajout au stock après validation') : t('Réception enregistrée sans suivi de stock')}</small></div>
          <Field label={t('Quantité reçue pour {description}', { description: line.description })} error={shownIssue?.field==='quantity' && shownIssue.lineId===line.id ? t(shownIssue.message) : undefined}><div className="receipt-quantity-input"><input name={`quantity-${line.id}`} type="text" inputMode="decimal" value={draft.quantities[line.id] ?? '0'} onChange={e=>edit({quantities:{...draft.quantities,[line.id]:e.target.value}})} /><span>{line.unit}</span></div></Field>
        </article>;})}
        <details className="receipt-details"><summary>{t('Ajouter la référence du bon ou une note · facultatif')}</summary><Field label={t('Référence')} hint={t('Exemple : BL-2026-012. 200 caractères maximum.')} error={shownIssue?.field==='reference' ? t(shownIssue.message) : undefined}><input name="reference" value={draft.reference} onChange={e=>edit({reference:e.target.value})} /></Field><Field label={t('Notes')} hint={t('Livraison partielle, colis abîmé ou consigne utile.')} error={shownIssue?.field==='notes' ? t(shownIssue.message) : undefined}><textarea name="notes" rows={3} value={draft.notes} onChange={e=>edit({notes:e.target.value})} /></Field></details>
      </fieldset>
      <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={onClose}>{t('Retour')}</Button><Button type="submit" disabled={locked || readOnly}>{working ? t('Enregistrement…') : t('Continuer vers la validation')}<ArrowRight size={17} /></Button></div>
    </form>
  </Modal>;
}

function ReceiptLines({ receipt, workspace, reverse }: { receipt: SupplierReceipt; workspace: Workspace; reverse?: boolean }) {
  useAppLanguage();
  const order=workspace.supplierOrders.find(row=>row.id===receipt.supplierOrderId);
  return <div className="receipt-review-lines">{receipt.lines.map(line=>{const tracked=order?.lines.find(row=>row.id===line.supplierOrderLineId)?.fulfillmentMode==='stocked_receipt';return <article key={line.id}><div><strong>{line.description}</strong><small>{tracked ? reverse ? t('Retrait du stock') : t('Ajout au stock') : t('Sans mouvement de stock')}</small></div><strong>{tracked ? reverse ? '− ' : '+ ' : ''}{formatCatalogQuantity(line.quantityMilli)} {line.unit}</strong></article>;})}</div>;
}

type ReviewLinks = { onOpenAccounting: () => void; onOpenCatalog: () => void; onOpenInvoice: (id: string) => void };
// The message stays in French here: these patterns read the original guidance, not its translation.
function ReceiptHelp({ message, disabled, onOpenAccounting, onOpenCatalog }: Pick<ReviewLinks,'onOpenAccounting'|'onOpenCatalog'> & {message:string;disabled:boolean}) {
  useAppLanguage();
  return <div className="receipt-inline-actions">{/période|exercice|compta/i.test(message) && <Button type="button" variant="secondary" disabled={disabled} onClick={onOpenAccounting}>{t('Ouvrir les exercices')}</Button>}{/stock|catalogue/i.test(message) && <Button type="button" variant="secondary" disabled={disabled} onClick={onOpenCatalog}>{t('Vérifier le stock')}</Button>}</div>;
}

export function IssueReceiptModal({ workspace, receiptId, busy, readOnly, actionError, onClose, onReadWorkspace, onConfirm, onEdit, ...links }: Shared & ReviewLinks & { receiptId:string; onEdit:(receipt:SupplierReceipt)=>void; onConfirm:(receipt:SupplierReceipt)=>Promise<boolean> }) {
  useAppLanguage();
  const receipt=workspace.supplierReceipts.find(row=>row.id===receiptId), order=workspace.supplierOrders.find(row=>row.id===receipt?.supplierOrderId);
  const [confirmedVersion,setConfirmedVersion]=useState(''),[attempted,setAttempted]=useState(false),[working,setWorking]=useState(false),[failure,setFailure]=useState('');
  const flight=useRef(false), alert=useRef<HTMLDivElement>(null), check=useRef<HTMLInputElement>(null);
  const locked=busy||working, confirmed=!!receipt && confirmedVersion===JSON.stringify(receipt);
  // Problems keep their French source for ReceiptHelp; the translation is only displayed.
  const problems=receiptIssueProblems(receipt,workspace), problemText=new Map<string,string>();
  if(receipt) for(const effect of receiptStockEffects(receipt,workspace)) if(effect.item && (!Number.isSafeInteger(effect.item.stockQuantityMilli) || BigInt(effect.item.stockQuantityMilli)+effect.quantity>BigInt(MAX_STOCK_QUANTITY_MILLI))) { const source=`La quantité de « ${effect.item.name} » dépasserait la capacité du stock. Vérifiez ses mouvements dans le catalogue.`; problems.push(source); problemText.set(source,t('La quantité de « {name} » dépasserait la capacité du stock. Vérifiez ses mouvements dans le catalogue.',{name:effect.item.name})); }
  const message=failure || (actionError ? receiptNativeIssue(actionError,order)?.message || t('La réception n’a pas été validée. Vos quantités restent enregistrées en brouillon. Actualisez les données et vérifiez le point indiqué.') : '');
  useEffect(()=>{if(!locked && (attempted || message)){ const target=problems.length || message ? alert.current : !confirmed ? check.current : null; focusReceiptProblem(target);}},[locked,attempted,message,problems.join('|'),confirmed]);
  async function act(refresh=false) {
    if(locked||flight.current||!refresh&&readOnly)return;
    if(!refresh){setAttempted(true);if(!receipt||problems.length||!confirmed)return;}
    flight.current=true;setWorking(true);setFailure('');
    try {if(refresh)requireReceiptWorkspace(await onReadWorkspace());else await onConfirm(structuredClone(receipt!));}
    catch(reason){setFailure(errorMessage(reason,t('Impossible de poursuivre. Réessayez après actualisation.')));}
    finally {flight.current=false;setWorking(false);}
  }
  return <Modal wide className="supplier-receipt-modal" title={t('Vérifier et valider la réception')} description={t('Vérifiez la date et les quantités. Les articles suivis seront ajoutés au stock.')} dismissible={!locked} onClose={onClose}>
    <ReceiptSteps review />
    <div className="receipt-context"><strong>{orderLabel(order)}</strong><span>{receipt ? t('Reçu le {date}', { date: formatDate(receipt.receiptDate) }) : t('Réception indisponible')}</span>{receipt?.reference && <span>{t('Bon : {reference}', { reference: receipt.reference })}</span>}</div>
    {receipt && <><ReceiptLines receipt={receipt} workspace={workspace}/>{receipt.notes && <p className="receipt-note receipt-note--multiline">{receipt.notes}</p>}</>}
    {(problems.length>0||message) && <div className="receipt-alert" ref={alert} role="alert" tabIndex={-1}><strong>{t('Avant de valider')}</strong>{problems.map((problem,index)=><p key={index}>{problemText.get(problem) ?? t(problem)}</p>)}{message&&<p>{t(message)}</p>}<ErrorDetails message={actionError}/><ReceiptHelp {...links} disabled={locked} message={`${problems.join(' ')} ${message} ${actionError}`}/><small>{t('La réception reste enregistrée. Retrouvez-la dans Achats → Réceptions après votre correction.')}</small></div>}
    {receipt?.status==='draft' && <label className="receipt-check"><input ref={check} type="checkbox" checked={confirmed} disabled={locked||readOnly||!!problems.length} onChange={e=>{setConfirmedVersion(e.target.checked?JSON.stringify(receipt):'');setAttempted(false);}}/><span>{t('J’ai vérifié la date et les quantités réellement reçues.')}</span></label>}
    {attempted&&!confirmed&&!problems.length&&!message&&<p className="receipt-note" role="alert">{t('Cochez la confirmation après avoir relu les quantités. Si la réception change, ce contrôle sera demandé à nouveau.')}</p>}
    {readOnly&&<p className="receipt-note">{t('Validation indisponible en lecture seule.')}</p>}
    <div className="receipt-inline-actions"><Button type="button" variant="secondary" disabled={locked} onClick={()=>void act(true)}><RefreshCw size={16}/>{t('Actualiser les réceptions')}</Button>{receipt?.status==='draft'&&<Button type="button" variant="secondary" disabled={locked||readOnly} onClick={()=>onEdit(receipt)}>{t('Corriger les quantités')}</Button>}</div>
    <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={onClose}>{t('Revenir aux réceptions')}</Button><Button type="button" disabled={locked||readOnly||receipt?.status!=='draft'} onClick={()=>void act()}><PackageCheck size={17}/>{t('Valider la réception')}</Button></div>
  </Modal>;
}

export function ReverseReceiptModal({ workspace, receipt: openedReceipt, busy, readOnly, actionError, onClose, onReadWorkspace, onConfirm, ...links }: Shared & ReviewLinks & {receipt:SupplierReceipt;onConfirm:(reason:string)=>Promise<boolean>}) {
  useAppLanguage();
  const receipt=workspace.supplierReceipts.find(row=>row.id===openedReceipt.id);
  const [reason,setReason]=useState(''),[attempted,setAttempted]=useState(false),[working,setWorking]=useState(false),[failure,setFailure]=useState('');
  const flight=useRef(false), input=useRef<HTMLTextAreaElement>(null), alert=useRef<HTMLDivElement>(null);
  const locked=busy||working, problems=receiptReverseProblems(receipt,workspace);
  const reasonError=attempted && (!reason.trim() || [...reason.trim()].length>500) ? t('Indiquez la raison de cette annulation en quelques mots (500 caractères maximum).') : '';
  const linked=workspace.supplierInvoiceMatches.find(match=>receipt?.lines.some(line=>line.id===match.supplierReceiptLineId));
  useEffect(()=>{if(!locked){const target=reasonError?input.current:failure||actionError||attempted&&problems.length?alert.current:null;focusReceiptProblem(target);}},[locked,reasonError,failure,actionError,attempted,problems.join('|')]);
  async function act(refresh=false){
    if(locked||flight.current||!refresh&&readOnly)return;
    if(!refresh){setAttempted(true);if(!reason.trim()||[...reason.trim()].length>500||problems.length)return;}
    flight.current=true;setWorking(true);setFailure('');
    try{if(refresh)requireReceiptWorkspace(await onReadWorkspace());else await onConfirm(reason.trim());}catch(error){setFailure(errorMessage(error,t('La correction n’a pas abouti. Votre motif reste présent.')));}finally{flight.current=false;setWorking(false);}
  }
  return <Modal wide className="supplier-receipt-modal" title={t('Annuler cette réception')} description={t('Cette correction retire du stock les articles suivis de cette réception. Son historique et votre motif restent conservés.')} onClose={onClose} dismissible={!locked}>
    {receipt&&<><div className="receipt-context"><strong>{receipt.number||t('Réception')}</strong><span>{formatDate(receipt.receiptDate)} · {receipt.reference||t('Sans référence de bon')}</span></div><ReceiptLines receipt={receipt} workspace={workspace} reverse/></>}
    {(problems.length>0||failure||actionError)&&<div className="receipt-alert" role="alert" ref={alert} tabIndex={-1}><strong>{t('Un point à corriger avant l’annulation')}</strong>{problems.map((p,i)=><p key={i}>{t(p)}</p>)}{failure&&<p>{t(failure)}</p>}{actionError&&<p>{t('L’annulation n’a pas été enregistrée. Vérifiez le point indiqué puis actualisez les réceptions.')}</p>}<ErrorDetails message={actionError}/><ReceiptHelp {...links} disabled={locked} message={`${problems.join(' ')} ${actionError}`}/>{linked&&<Button type="button" variant="secondary" disabled={locked} onClick={()=>links.onOpenInvoice(linked.supplierInvoiceId)}>{t('Ouvrir la facture liée')}</Button>}</div>}
    <Field label={t('Motif de la correction')} required hint={t('Par exemple : colis retourné au fournisseur ou réception saisie deux fois.')} error={reasonError}><textarea ref={input} rows={3} value={reason} disabled={locked||readOnly} onChange={e=>{setReason(e.target.value);setAttempted(false);}}/></Field>
    <p className="receipt-note">{t('Cette action concerne toute la réception. Une facture déjà validée doit être corrigée depuis les achats. L’application vérifiera aussi que la période comptable autorise la correction.')}</p>
    <Button type="button" variant="secondary" disabled={locked} onClick={()=>void act(true)}>{t('Actualiser les réceptions')}</Button>
    <div className="form-actions"><Button type="button" variant="secondary" disabled={locked} onClick={onClose}>{t('Retour')}</Button><Button type="button" variant="danger" disabled={locked||readOnly||receipt?.status!=='issued'} onClick={()=>void act()}>{t('Confirmer l’annulation')}</Button></div>
  </Modal>;
}
