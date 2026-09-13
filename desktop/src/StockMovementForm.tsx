import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowDownToLine, ArrowUpToLine, RotateCcw } from 'lucide-react';
import { desktopApi } from './bridge';
import { formatCatalogQuantity, MAX_STOCK_QUANTITY_MILLI, stockBalanceAfter, stockQuantityFromInput } from './catalog';
import { requireStockWorkspace, stockFormIssue, stockNativeIssue, type StockDraft, type StockIssue } from './stockWorkflow';
import { availabilityForCatalogItem } from './orderFlow';
import type { StockMovementType, Workspace } from './types';
import { errorMessage, formatDate, todayIso } from './utils';
import { Button, Field, FormActions, Modal } from './ui';
import './stock-workflow.css';

type ActionRunner = (action: () => Promise<Workspace>, message: string, close?: boolean, onError?: (reason: unknown) => void, validateRead?: (workspace: Workspace) => void) => Promise<boolean>;
const config = {
  entry: { title:'Ajouter du stock', quantity:'Quantité reçue', help:'Ajoutez un stock de départ ou une arrivée manuelle. Une réception déjà enregistrée dans Achats a déjà mis le stock à jour.', submit:'Enregistrer l’entrée', icon:ArrowDownToLine },
  exit: { title:'Retirer du stock', quantity:'Quantité utilisée ou sortie', help:'Renseignez ce qui quitte le dépôt en dehors d’une livraison déjà enregistrée.', submit:'Enregistrer la sortie', icon:ArrowUpToLine },
  correction: { title:'Vérifier l’inventaire', quantity:'Quantité réellement comptée', help:'Comptez ce qui est présent. Zentra calcule la correction à apporter.', submit:'Enregistrer la correction', icon:RotateCcw },
};

export function StockMovementForm({itemId,movementType,requestId,workspace,busy,readOnly,close,act,onReadWorkspace}: {
  itemId:string; movementType:StockMovementType; requestId:string; workspace:Workspace; busy:boolean; readOnly:boolean; close:()=>void; act:ActionRunner; onReadWorkspace:()=>Promise<Workspace>;
}) {
  const item=workspace.catalogItems.find(row=>row.id===itemId);
  const stock=item?availabilityForCatalogItem(item,workspace.stockReservationEvents,workspace.stockAvailability):{onHandMilli:0,reservedMilli:0,availableMilli:0};
  const [expected,setExpected]=useState(item?.stockQuantityMilli ?? 0), [counted,setCounted]=useState(true);
  const [draft,setDraft]=useState<StockDraft>({quantity:'',date:todayIso(),reason:'',reference:''});
  const [deltaInput,setDeltaInput]=useState(''), [countInput,setCountInput]=useState('');
  const [review,setReview]=useState(false), [saving,setSaving]=useState(false), [reading,setReading]=useState(false);
  const [issue,setIssue]=useState<StockIssue|null>(null), [failure,setFailure]=useState('');
  const formRef=useRef<HTMLFormElement>(null), alertRef=useRef<HTMLDivElement>(null), inFlight=useRef(false);
  const reviewRef=useRef<HTMLElement>(null);
  const locked=busy||saving||reading, unavailable=!item||!!item.archivedAt||item.kind!=='product'||!item.trackStock;
  const isCount=movementType==='correction'&&counted;
  const changed=isCount&&!!item&&expected!==item.stockQuantityMilli;
  const entered=stockQuantityFromInput(draft.quantity);
  const delta=entered===null?null:isCount?entered-expected:movementType==='exit'?-entered:entered;
  const after=delta===null||!item?null:stockBalanceAfter(item.stockQuantityMilli,'correction',delta);
  const info=config[movementType], Icon=info.icon;
  useEffect(()=>{if(changed||unavailable)setReview(false);},[changed,unavailable]);
  useEffect(()=>{if(review){reviewRef.current?.focus({preventScroll:true});reviewRef.current?.scrollIntoView({block:'center'});}},[review]);
  useEffect(()=>{
    if(locked)return;
    const element=issue&&issue.field!=='item'?formRef.current?.elements.namedItem(issue.field) as HTMLElement|null:failure||changed||unavailable?alertRef.current:null;
    if(!element)return; const field=element.closest<HTMLElement>('.field')||element;
    field.style.scrollMarginBlockEnd=`${(formRef.current?.querySelector('.form-actions')?.getBoundingClientRect().height||0)+20}px`;
    element.focus({preventScroll:true});field.scrollIntoView({block:'center'});
  },[issue,failure,changed,unavailable,locked]);
  const change=(field:keyof StockDraft,value:string)=>{if(locked||readOnly)return;setDraft(previous=>({...previous,[field]:value}));setIssue(null);setFailure('');setReview(false);};
  const error=(field:StockIssue['field'])=>issue?.field===field?issue.message:undefined;
  function refused(reason:unknown){setReview(false);setIssue(stockNativeIssue(reason));setFailure(errorMessage(reason,'Le mouvement n’a pas pu être confirmé. Votre saisie est conservée.'));}
  async function refresh(){if(locked||inFlight.current)return;setReading(true);setFailure('');try{await onReadWorkspace();}catch(reason){setFailure(errorMessage(reason,'Impossible de relire les quantités. Réessayez.'));}finally{setReading(false);}}
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();if(locked||readOnly||inFlight.current||changed)return;
    const invalid=stockFormIssue(item,movementType,isCount,expected,stock.reservedMilli,draft);
    if(invalid){setIssue(invalid);setReview(false);return;}
    setIssue(null);setFailure('');if(!review){setReview(true);return;}
    if(!item||entered===null)return;
    const common={requestId,catalogItemId:item.id,reason:draft.reason.trim(),reference:draft.reference.trim(),date:draft.date};
    inFlight.current=true;setSaving(true);
    try{await act(()=>isCount?desktopApi.recordStockCount({...common,expectedQuantityMilli:expected,countedQuantityMilli:entered}):movementType==='entry'?desktopApi.recordStockEntry({...common,quantityMilli:entered}):movementType==='exit'?desktopApi.recordStockExit({...common,quantityMilli:entered}):desktopApi.recordStockCorrection({...common,deltaQuantityMilli:entered}), 'Le mouvement a été enregistré. Les quantités du catalogue sont à jour.',true,refused,requireStockWorkspace);}
    catch(reason){refused(reason);}finally{inFlight.current=false;setSaving(false);}
  }
  const quantityLabel=isCount?info.quantity:movementType==='correction'?'Quantité à ajouter ou retirer':info.quantity;
  return <Modal title={`${info.title} · ${item?.name||'Produit indisponible'}`} description={info.help} onClose={close} dismissible={!locked} wide className="stock-workflow-modal">
    <form ref={formRef} noValidate onSubmit={submit} className="stock-workflow">
      <ol className="stock-workflow-steps" aria-label="Étapes du mouvement"><li aria-current={!review?'step':undefined}>1 · Quantité et motif</li><li aria-current={review?'step':undefined}>2 · Vérification</li></ol>
      <section className="stock-workflow-balances" aria-label="Quantités du produit"><div><span>Présent au dépôt</span><strong>{formatCatalogQuantity(stock.onHandMilli)} <small>{item?.unit}</small></strong></div><div><span>Réservé aux commandes</span><strong>{formatCatalogQuantity(stock.reservedMilli)} <small>{item?.unit}</small></strong></div><div><span>Disponible</span><strong>{formatCatalogQuantity(stock.availableMilli)} <small>{item?.unit}</small></strong></div></section>
      <p className="stock-workflow-explanation">Le stock disponible correspond à ce qui est présent, moins les quantités promises dans les commandes.</p>
      <Button type="button" variant="ghost" size="small" disabled={locked} onClick={()=>void refresh()}>Actualiser les quantités</Button>
      {(changed||unavailable||failure)&&<div className="stock-workflow-alert" role="alert" tabIndex={-1} ref={alertRef}>
        <strong>{unavailable?'Vérifiez la fiche du produit':changed?'Les quantités ont changé':'Vérifions ce point'}</strong>
        <p>{unavailable?'Cette référence est absente, archivée ou sans suivi de stock. Revenez au catalogue pour vérifier sa fiche.':changed?`Le stock relu était ${formatCatalogQuantity(expected)} ${item?.unit}. Il est maintenant de ${formatCatalogQuantity(item!.stockQuantityMilli)} ${item?.unit}. Votre comptage est conservé.`:issue?.message||'Votre saisie est conservée. Corrigez le point indiqué ou relisez les quantités.'}</p>
        {failure&&<details><summary>Détail du message</summary><p>{failure}</p></details>}
        <div><Button type="button" variant="secondary" disabled={locked} onClick={()=>void refresh()}>Relire les quantités</Button>{(unavailable||issue?.field==='item')&&<Button type="button" variant="secondary" disabled={locked} onClick={close}>Revenir au catalogue</Button>}{changed&&<Button type="button" disabled={locked||readOnly} onClick={()=>{setExpected(item!.stockQuantityMilli);setReview(false);setIssue(null);setFailure('');}}>Utiliser le stock actuel</Button>}</div>
      </div>}
      <fieldset disabled={locked||readOnly||unavailable||changed} hidden={review} className="stock-workflow-fields">
        <section><h3><Icon size={18}/>{movementType==='correction'?'Que constatez-vous ?':'Quelle quantité ?'}</h3>
          {movementType==='correction'&&<div className="stock-workflow-choice" role="group" aria-label="Méthode de correction"><Button type="button" variant="secondary" aria-pressed={counted} onClick={()=>{if(!counted){setDeltaInput(draft.quantity);setDraft({...draft,quantity:countInput});setCounted(true);setIssue(null);setFailure('');}}}>Quantité comptée</Button><Button type="button" variant="ghost" aria-pressed={!counted} onClick={()=>{if(counted){setCountInput(draft.quantity);setDraft({...draft,quantity:deltaInput});setCounted(false);setIssue(null);setFailure('');}}}>Écart (+ ou −)</Button></div>}
          <div className="form-grid"><Field label={quantityLabel} required error={error('quantity')} hint={movementType==='correction'&&!isCount?'Exemple : −2 pour retirer 2 unités, +3 pour en ajouter 3.':'Exemple : 12 ou 12,5. Trois décimales maximum.'}><input name="quantity" inputMode="decimal" value={draft.quantity} onChange={event=>change('quantity',event.target.value)} autoFocus aria-invalid={!!error('quantity')}/></Field><Field label="Date du mouvement" required error={error('date')}><input name="date" type="date" value={draft.date} onChange={event=>change('date',event.target.value)} aria-invalid={!!error('date')}/></Field></div>
        </section>
        <section><Field label="Pourquoi le stock change-t-il ?" required wide error={error('reason')} hint="Ce motif vous aidera à comprendre l’historique plus tard."><textarea name="reason" rows={3} value={draft.reason} onChange={event=>change('reason',event.target.value)} maxLength={500} placeholder={isCount?'Ex. Inventaire du dépôt':'Ex. Produits reçus du fournisseur'} aria-invalid={!!error('reason')}/></Field>
          <div className="stock-workflow-choice" role="group" aria-label="Motifs habituels">{(movementType==='entry'?['Livraison reçue','Stock de départ']:movementType==='exit'?['Matériel utilisé','Produit abîmé']:['Inventaire du dépôt','Écart de comptage']).map(reason=><Button type="button" key={reason} variant="ghost" size="small" onClick={()=>change('reason',reason)}>{reason}</Button>)}</div>
          <Field label="Référence du justificatif" error={error('reference')} hint="Facultatif : numéro du bon de livraison ou de l’inventaire."><input name="reference" value={draft.reference} onChange={event=>change('reference',event.target.value)} maxLength={200}/></Field>
        </section>
      </fieldset>
      {review&&<section ref={reviewRef} tabIndex={-1} className="stock-workflow-review" aria-label="Vérification du mouvement"><h3>Relisez avant d’enregistrer</h3><dl><div><dt>Produit</dt><dd>{item?.name}</dd></div><div><dt>{isCount?'Quantité comptée':'Variation du stock'}</dt><dd>{formatCatalogQuantity(isCount?entered!:delta!)} {item?.unit}</dd></div><div><dt>Date</dt><dd>{formatDate(draft.date)}</dd></div><div><dt>Motif</dt><dd>{draft.reason}</dd></div>{draft.reference&&<div><dt>Référence</dt><dd>{draft.reference}</dd></div>}</dl><p>L’historique conservera ce mouvement. Pour le rectifier ensuite, vous pourrez ajouter une correction.</p></section>}
      {after!==null&&!changed&&Number.isSafeInteger(after)&&after<=MAX_STOCK_QUANTITY_MILLI&&<div className={`stock-workflow-result ${after<stock.reservedMilli?'is-invalid':''}`} aria-live="polite"><span>Après le mouvement</span><strong>{formatCatalogQuantity(after)} {item?.unit} au dépôt</strong><small>{formatCatalogQuantity(after-stock.reservedMilli)} {item?.unit} disponibles après réservations</small>{after<stock.reservedMilli&&<p>La quantité est insuffisante. Vérifiez la saisie ou ajustez les réservations dans Commandes clients avant de continuer.</p>}</div>}
      <FormActions onCancel={review?()=>{setReview(false);}:close} cancelLabel={review?'Modifier ma saisie':'Annuler'} busy={locked} disabled={readOnly||unavailable||changed} submitLabel={review?info.submit:'Vérifier le mouvement'}/>
    </form>
  </Modal>;
}
