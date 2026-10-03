/** Local retained-creation consultation only. No storage writer, clock, replay,
 * native call or guessed draft selection lives in this leaf. */
import {FormDraftSession,FORM_DRAFT_PREFIX,FORM_DRAFT_MAX_ENTRY_BYTES,formDraftKey,type DraftStorage,type FormDraftScope} from './formDrafts';
import {validDocumentFormDraft,type DocumentFormDraft} from './documentFormDraft';
import {freezeDocumentCreationRequest,type DocumentCreationRequest} from './documentCreationRequest';
import type {FormDraftIdentityValue} from './useFormDraft';
export type DocumentCreationConsultation=Readonly<{scope:FormDraftScope;fingerprint:string;creationRequestId:string;title:string;request:DocumentCreationRequest}>;
export const documentConsultationText={
 fr:{missing:'Aucune confirmation locale ne correspond à cette tentative. Aucun renvoi ne peut être fait pendant cette consultation.',open:'Consulter une création en attente',choose:'Choisir la création à vérifier',intro:'Cette saisie reste sur cet appareil. Vous pouvez la relire et vérifier son reçu, sans rien modifier ni renvoyer.',title:'Création en attente',empty:'Cette saisie ne peut plus être consultée. Fermez cette fenêtre et relisez les créations en attente.',close:'Fermer'},
 de:{missing:'Für diesen Versuch liegt keine lokale Bestätigung vor. In dieser Ansicht kann nichts erneut gesendet werden.',open:'Ausstehende Erstellung ansehen',choose:'Zu prüfende Erstellung auswählen',intro:'Diese Eingabe bleibt auf diesem Gerät. Sie können sie lesen und ihren Beleg prüfen, ohne etwas zu ändern oder erneut zu senden.',title:'Ausstehende Erstellung',empty:'Diese Eingabe kann nicht mehr angezeigt werden. Schließen Sie dieses Fenster und lesen Sie die ausstehenden Erstellungen erneut ein.',close:'Schließen'},
 it:{missing:'Nessuna conferma locale corrisponde a questo tentativo. Durante questa consultazione non è possibile inviare di nuovo nulla.',open:'Consulta una creazione in sospeso',choose:'Scegli la creazione da verificare',intro:'Questi dati restano su questo dispositivo. Puoi leggerli e verificare la ricevuta, senza modificarli né inviarli di nuovo.',title:'Creazione in sospeso',empty:'Questi dati non sono più consultabili. Chiudi questa finestra e rileggi le creazioni in sospeso.',close:'Chiudi'},
 en:{missing:'No local confirmation matches this attempt. Nothing can be resent from this view.',open:'View a pending creation',choose:'Choose the creation to check',intro:'This entry remains on this device. You can read it and check its receipt without changing or resending anything.',title:'Pending creation',empty:'This entry can no longer be viewed. Close this window and reread the pending creations.',close:'Close'},
} as const;
export function consultationIdentityMatches(selection:DocumentCreationConsultation,companyId:string|undefined,identity:Readonly<FormDraftIdentityValue>){
 return identity.ready===true&&companyId===selection.scope.companyId&&identity.companyId===selection.scope.companyId&&identity.memberId===selection.scope.memberId&&(identity.organizationId||'')===(selection.scope.organizationId||'');
}
export function validConsultationDraft(value:unknown,selection:DocumentCreationConsultation):value is DocumentFormDraft{
 return validDocumentFormDraft(value)&&!!value.documentCreationRequest&&value.documentCreationId===selection.creationRequestId&&JSON.stringify(value.documentCreationRequest)===JSON.stringify(selection.request);
}
export function listDocumentCreationConsultations(companyId:string|undefined,identity:Readonly<FormDraftIdentityValue>,entity:'quotes'|'invoices',storage:()=>DraftStorage=()=>localStorage):readonly DocumentCreationConsultation[]{
 if(identity.ready!==true||!companyId||identity.companyId!==companyId||!identity.memberId)return [];
 try{
  const store=storage();if(store.length>1000)return [];
  const keys=Array.from({length:store.length},(_,i)=>store.key(i)).filter((key):key is string=>typeof key==='string'&&key.startsWith(FORM_DRAFT_PREFIX));
  const result:DocumentCreationConsultation[]=[];
  for(const key of keys){
   let parts:unknown;try{parts=JSON.parse(decodeURIComponent(key.slice(FORM_DRAFT_PREFIX.length)));}catch{continue;}
   if(!Array.isArray(parts)||parts.length!==6||parts.some(part=>typeof part!=='string')||parts[0]!==companyId||parts[1]!== (identity.organizationId||'')||parts[2]!==identity.memberId||parts[3]!==entity||parts[4]!=='new')continue;
   const scope:FormDraftScope={companyId,organizationId:identity.organizationId,memberId:identity.memberId,type:entity,context:parts[5]};if(formDraftKey(scope)!==key)continue;
   const raw=store.getItem(key);if(!raw||raw.length*2>FORM_DRAFT_MAX_ENTRY_BYTES)continue;
   let record:any;try{record=JSON.parse(raw);}catch{continue;}
   if(typeof record?.fingerprint!=='string'||!validDocumentFormDraft(record.value)||!record.value.documentCreationRequest)continue;
   const request=freezeDocumentCreationRequest(record.value.documentCreationRequest);
   if(request.companyId!==companyId||request.memberId!==identity.memberId||request.input.entity!==entity)continue;
   const selection=Object.freeze({scope:Object.freeze(scope),fingerprint:record.fingerprint,creationRequestId:request.creationRequestId,title:record.value.documentTitle,request});
   const session=new FormDraftSession<DocumentFormDraft|null>({scope,initial:null,fingerprint:record.fingerprint,validate:(value):value is DocumentFormDraft|null=>validConsultationDraft(value,selection),storage});
   const checked=session.getSnapshot();if(checked.storageError||checked.invalid||checked.conflict||checked.completedResidual||!checked.pending||JSON.stringify(checked.pending.value)!==JSON.stringify(record.value))continue;
   result.push(selection);
  }
  return Object.freeze(result);
 }catch{return [];}
}
