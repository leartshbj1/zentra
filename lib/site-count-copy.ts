import type { SiteLanguage } from './site-language';
const labels = {
  people: {fr:['personne','personnes'],de:['Person','Personen'],it:['persona','persone'],en:['person','people']},
  actions: {fr:['action','actions'],de:['Aktion','Aktionen'],it:['azione','azioni'],en:['action','actions']},
  attempts: {fr:['essai','essais'],de:['Versuch','Versuche'],it:['tentativo','tentativi'],en:['attempt','attempts']},
  invoices: {fr:['facture','factures'],de:['Rechnung','Rechnungen'],it:['fattura','fatture'],en:['invoice','invoices']},
  followups: {fr:['rappel','rappels'],de:['Erinnerung','Erinnerungen'],it:['promemoria','promemoria'],en:['reminder','reminders']},
  solicitations: {fr:['démarchage','démarchages'],de:['Werbeanfrage','Werbeanfragen'],it:['contatto commerciale','contatti commerciali'],en:['sales enquiry','sales enquiries']},
  pendingMessages: {fr:['message à vérifier','messages à vérifier'],de:['Nachricht zu prüfen','Nachrichten zu prüfen'],it:['messaggio da verificare','messaggi da verificare'],en:['message to review','messages to review']},
  sortedToday: {fr:['message classé automatiquement aujourd’hui','messages classés automatiquement aujourd’hui'],de:['Nachricht heute automatisch eingeordnet','Nachrichten heute automatisch eingeordnet'],it:['messaggio classificato automaticamente oggi','messaggi classificati automaticamente oggi'],en:['message automatically sorted today','messages automatically sorted today']},
  placesAvailable: {fr:['place disponible, titulaire compris.','places disponibles, titulaire compris.'],de:['verfügbarer Platz, Inhaber eingeschlossen.','verfügbare Plätze, Inhaber eingeschlossen.'],it:['posto disponibile, titolare compreso.','posti disponibili, titolare compreso.'],en:['place available, including the owner.','places available, including the owner.']},
} satisfies Record<string,Record<SiteLanguage,[string,string]>>;
export type SiteCountKind = keyof typeof labels;
export function translateSiteCount(kind:SiteCountKind,count:number,language:SiteLanguage) {
  const plural=language==='fr'?count>1:count!==1;
  return `${count} ${labels[kind][language][plural?1:0]}`;
}
