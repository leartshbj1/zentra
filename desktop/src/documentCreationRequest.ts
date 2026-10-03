import type {AppLanguage} from './language';
import {withKnownErrorIncident} from './diagnostics';

export type DocumentCreationInput = {entity:'quotes'|'invoices';id:null;data:Record<string,unknown>;items:Record<string,unknown>[]};
/** Durable business identity only. A connection nonce must never be persisted. */
export type DocumentCreationRequest = Readonly<{requestVersion:1;creationRequestId:string;companyId:string;memberId:string;input:DocumentCreationInput}>;
export type DocumentCreationReceipt = Readonly<{receiptVersion:1;creationRequestId:string;entity:'quotes'|'invoices';status:'missing'|'confirmed'|'deleted';documentId:string;originalResponse:{document:Record<string,unknown>;items:Record<string,unknown>[];creationRequestId:string}|null;currentDocument:Record<string,unknown>|null;currentItems:Record<string,unknown>[];originalMatchesCurrent:boolean|null}>;
export const validDocumentCreationId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exactId=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=2000&&value===value.trim()&&!value.includes('\0');
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
/** Copy JSON without invoking a getter or a toJSON method. Keep property/line order. */
function cloneJson(value:unknown,depth=0):unknown {
  if(depth>20)throw Error('La tentative de création ne peut pas être conservée.');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value)) {
    if(value.length>1000)throw Error('La tentative de création ne peut pas être conservée.');
    const result:unknown[]=[];
    for(let index=0;index<value.length;index++){const item=Object.getOwnPropertyDescriptor(value,String(index));if(!item||!('value'in item))throw Error('La tentative de création ne peut pas être conservée.');result.push(cloneJson(item.value,depth+1));}
    return Object.freeze(result);
  }
  if(!record(value)||Object.keys(value).length>150)throw Error('La tentative de création ne peut pas être conservée.');
  const result:Record<string,unknown>={};
  for(const key of Object.keys(value)){const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||!('value'in descriptor)||key==='__proto__')throw Error('La tentative de création ne peut pas être conservée.');Object.defineProperty(result,key,{value:cloneJson(descriptor.value,depth+1),enumerable:true});}
  return Object.freeze(result);
}
function ownValue(value:Record<string,unknown>,key:string):unknown {const descriptor=Object.getOwnPropertyDescriptor(value,key);return descriptor&&'value'in descriptor?descriptor.value:undefined;}
const keys=(value:Record<string,unknown>,expected:readonly string[])=>Object.keys(value).length===expected.length&&expected.every(key=>Object.hasOwn(value,key));
export function validDocumentCreationInput(value:unknown):value is DocumentCreationInput {
  if(!record(value)||!keys(value,['entity','id','data','items']))return false;
  const entity=ownValue(value,'entity'),items=ownValue(value,'items'),data=ownValue(value,'data');
  if(!['quotes','invoices'].includes(entity as string)||ownValue(value,'id')!==null||!record(data)||!Array.isArray(items)||!items.length||items.length>500)return false;
  try {const copy=cloneJson(value);return JSON.stringify(copy).length<=180000;}catch{return false;}
}
export function validDocumentCreationRequest(value:unknown):value is DocumentCreationRequest {
  if(!record(value)||!keys(value,['requestVersion','creationRequestId','companyId','memberId','input']))return false;
  return ownValue(value,'requestVersion')===1&&validDocumentCreationId(ownValue(value,'creationRequestId'))&&exactId(ownValue(value,'companyId'))&&exactId(ownValue(value,'memberId'))&&validDocumentCreationInput(ownValue(value,'input'));
}
export function freezeDocumentCreationRequest(value:unknown):DocumentCreationRequest {
  if(!validDocumentCreationRequest(value))throw Error('La tentative de création doit être vérifiée avant de continuer.');
  return cloneJson(value) as DocumentCreationRequest;
}
export function prepareDocumentCreationRequest(creationRequestId:string,input:DocumentCreationInput,companyId:string,memberId:string):DocumentCreationRequest {
  return freezeDocumentCreationRequest({requestVersion:1,creationRequestId,companyId,memberId,input});
}
export function readDocumentCreationAcknowledgement(value:unknown,request:DocumentCreationRequest):{document:Record<string,unknown>;items:Record<string,unknown>[];creationRequestId:string}{
 const safe=cloneJson(value);
 if(!record(safe)||!keys(safe,['document','items','creationRequestId'])||safe.creationRequestId!==request.creationRequestId||!record(safe.document)||safe.document.id!==request.creationRequestId||!Array.isArray(safe.items)||!safe.items.length)throw Error('La confirmation de cette création est incompatible. Vérifiez le document enregistré.');
 return safe as {document:Record<string,unknown>;items:Record<string,unknown>[];creationRequestId:string};
}
export function readDocumentCreationReceipt(value:unknown,request:DocumentCreationRequest):DocumentCreationReceipt {
  const safe=cloneJson(value);
  if(!record(safe)||!keys(safe,['receiptVersion','creationRequestId','entity','status','documentId','originalResponse','currentDocument','currentItems','originalMatchesCurrent'])||safe.receiptVersion!==1||safe.creationRequestId!==request.creationRequestId||safe.documentId!==request.creationRequestId||safe.entity!==request.input.entity||!['missing','confirmed','deleted'].includes(safe.status as string)||!Array.isArray(safe.currentItems))throw Error('La confirmation de cette création est incompatible. Vérifiez le document enregistré.');
  if(safe.status==='missing'){
    if(safe.originalResponse!==null||safe.currentDocument!==null||safe.currentItems.length||safe.originalMatchesCurrent!==null)throw Error('La confirmation de cette création est incompatible. Vérifiez le document enregistré.');
  }else{
    const original=safe.originalResponse;
    if(!record(original)||!keys(original,['document','items','creationRequestId'])||original.creationRequestId!==request.creationRequestId||!record(original.document)||original.document.id!==request.creationRequestId||!Array.isArray(original.items)||!original.items.length)throw Error('La confirmation de cette création est incompatible. Vérifiez le document enregistré.');
    if(safe.status==='deleted'?(safe.currentDocument!==null||safe.currentItems.length||safe.originalMatchesCurrent!==null):(!record(safe.currentDocument)||safe.currentDocument.id!==request.creationRequestId||typeof safe.originalMatchesCurrent!=='boolean'))throw Error('La confirmation de cette création est incompatible. Vérifiez le document enregistré.');
  }
  return safe as DocumentCreationReceipt;
}
// Only errors created at the explicit lost-confirmation boundary carry this identity.
// Messages, names, prototypes, causes and accessors cannot reproduce the brand.
const unconfirmedDocumentCreations = new WeakSet<object>();
export function isDocumentCreationUnconfirmedError(reason: unknown): boolean {
  return reason !== null && typeof reason === 'object' && unconfirmedDocumentCreations.has(reason);
}

/** Deliberately ordinary: neither an ID-only proof nor an automatic retry. */
export class DocumentCreationUnconfirmedError extends Error {
  constructor(reason:unknown){super('La création du document doit être vérifiée avant tout nouvel envoi.');this.name='DocumentCreationUnconfirmedError';unconfirmedDocumentCreations.add(this);withKnownErrorIncident(this,reason);}
}
export const documentCreationText:Record<AppLanguage,{uncertain:string;instruction:string;probe:string;missing:string;retry:string;confirmed:string;changed:string;deleted:string;finish:string;refresh:string;storage:string;localRetry:string;legacy:string;prepare:string}>= {
 fr:{uncertain:'Vérifions la création',instruction:'Votre saisie est conservée. Aucun nouveau document ne sera envoyé avant la vérification.',probe:'Vérifier cette création',missing:'Aucune confirmation locale ne correspond à cette tentative. Vous pouvez renvoyer exactement la même saisie.',retry:'Renvoyer la même création',confirmed:'La création est confirmée',changed:'Le document enregistré a été modifié depuis sa création. La confirmation initiale reste distincte de son état actuel.',deleted:'La création est confirmée, mais le document est absent de cet espace. Cette tentative ne peut pas le recréer.',finish:'Terminer cette saisie',refresh:'Actualiser les documents',storage:'La saisie ou sa confirmation ne peut pas être conservée sur cet appareil. Gardez cette fenêtre ouverte pour vérifier son enregistrement.',localRetry:'Réessayer la sauvegarde locale',legacy:'Ce brouillon ancien ne permet pas de reconnaître une précédente création. Vérifiez les documents avant de préparer une nouvelle tentative.',prepare:'Préparer une nouvelle tentative'},
 de:{uncertain:'Erstellung prüfen',instruction:'Ihre Eingaben bleiben gespeichert. Vor der Prüfung wird kein neues Dokument gesendet.',probe:'Diese Erstellung prüfen',missing:'Für diesen Versuch liegt keine lokale Bestätigung vor. Sie können exakt dieselben Eingaben erneut senden.',retry:'Dieselbe Erstellung erneut senden',confirmed:'Die Erstellung ist bestätigt',changed:'Das gespeicherte Dokument wurde seit der Erstellung geändert. Die ursprüngliche Bestätigung bleibt vom aktuellen Stand getrennt.',deleted:'Die Erstellung ist bestätigt, aber das Dokument fehlt in diesem Arbeitsbereich. Dieser Versuch kann es nicht erneut erstellen.',finish:'Diese Eingabe abschließen',refresh:'Dokumente aktualisieren',storage:'Die Eingaben oder ihre Bestätigung können auf diesem Gerät nicht gespeichert werden. Lassen Sie dieses Fenster offen, um die Speicherung zu prüfen.',localRetry:'Lokale Speicherung erneut versuchen',legacy:'Dieser ältere Entwurf kann einer vorherigen Erstellung nicht zugeordnet werden. Prüfen Sie die Dokumente, bevor Sie einen neuen Versuch vorbereiten.',prepare:'Neuen Versuch vorbereiten'},
 it:{uncertain:'Verifica la creazione',instruction:'I dati inseriti sono conservati. Nessun nuovo documento sarà inviato prima della verifica.',probe:'Verifica questa creazione',missing:'Nessuna conferma locale corrisponde a questo tentativo. Puoi inviare di nuovo esattamente gli stessi dati.',retry:'Invia di nuovo la stessa creazione',confirmed:'La creazione è confermata',changed:'Il documento registrato è stato modificato dopo la creazione. La conferma iniziale resta distinta dal suo stato attuale.',deleted:'La creazione è confermata, ma il documento è assente da questo spazio. Questo tentativo non può ricrearlo.',finish:'Termina questa compilazione',refresh:'Aggiorna i documenti',storage:'I dati o la loro conferma non possono essere conservati su questo dispositivo. Tieni aperta questa finestra per verificare la registrazione.',localRetry:'Riprova il salvataggio locale',legacy:'Questa vecchia bozza non permette di riconoscere una creazione precedente. Verifica i documenti prima di preparare un nuovo tentativo.',prepare:'Prepara un nuovo tentativo'},
 en:{uncertain:'Check this creation',instruction:'Your entries are retained. No new document will be sent before this check.',probe:'Check this creation',missing:'No local confirmation matches this attempt. You may resend exactly the same entries.',retry:'Resend the same creation',confirmed:'The creation is confirmed',changed:'The recorded document has changed since creation. The initial confirmation remains separate from its current state.',deleted:'The creation is confirmed, but the document is absent from this workspace. This attempt cannot recreate it.',finish:'Finish these entries',refresh:'Refresh documents',storage:'These entries or their confirmation cannot be retained on this device. Keep this window open to check the recorded result.',localRetry:'Retry local storage',legacy:'This older draft cannot identify a previous creation. Check recorded documents before preparing a new attempt.',prepare:'Prepare a new attempt'},
};
