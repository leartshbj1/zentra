import type { SiteLanguage } from './site-language';

/** Small public service messages also used outside the React rendering pipeline. */
const messages = {
  maintenance: {
    fr: 'Zentra prépare le nouvel espace Phase 2. Réessayez dans quelques minutes.',
    de: 'Zentra bereitet den neuen Bereich für Phase 2 vor. Versuchen Sie es in einigen Minuten erneut.',
    it: 'Zentra sta preparando il nuovo spazio della fase 2. Riprovate tra qualche minuto.',
    en: 'Zentra is preparing the new Phase 2 workspace. Please try again in a few minutes.',
  },
  zendeskTitle: {fr:'Connexion Zendesk · Zentra',de:'Zendesk-Verbindung · Zentra',it:'Connessione Zendesk · Zentra',en:'Zendesk connection · Zentra'},
  zendeskHeading: {fr:'Connexion à reprendre',de:'Verbindung erneut herstellen',it:'Riprendere la connessione',en:'Resume your connection'},
  zendeskReturn: {fr:'Revenir à mes connexions',de:'Zurück zu meinen Verbindungen',it:'Torna alle mie connessioni',en:'Back to my connections'},
} as const;
export const siteServiceCopy = (key:keyof typeof messages,language:SiteLanguage) => messages[key][language];

const subjects:Record<string,Record<SiteLanguage,string>> = {
  'Passage au pack Zentra Complet':{fr:'Passage au pack Zentra Complet',de:'Wechsel zum Paket Zentra Komplett',it:'Passaggio al pacchetto Zentra Completo',en:'Switch to the Zentra Complete bundle'},
  'Suppression de mon compte Zentra':{fr:'Suppression de mon compte Zentra',de:'Löschung meines Zentra-Kontos',it:'Eliminazione del mio account Zentra',en:'Delete my Zentra account'},
  'Installation Windows':{fr:'Installation Windows',de:'Windows-Installation',it:'Installazione Windows',en:'Windows installation'},
  'Installation Mac':{fr:'Installation Mac',de:'Mac-Installation',it:'Installazione Mac',en:'Mac installation'},
  'Zentra - demande relative aux données':{fr:'Zentra - demande relative aux données',de:'Zentra - Anfrage zu meinen Daten',it:'Zentra - richiesta relativa ai dati',en:'Zentra - data request'},
  'Zentra - données et sécurité':{fr:'Zentra - données et sécurité',de:'Zentra - Daten und Sicherheit',it:'Zentra - dati e sicurezza',en:'Zentra - data and security'},
};
/** Only curated subjects change; recipient, body and other parameters remain intact. */
export function localizedSiteMailto(value:string,language:SiteLanguage):string {
  if(language==='fr'||!value.startsWith('mailto:'))return value;
  const separator=value.indexOf('?');if(separator<0)return value;
  const parameters=new URLSearchParams(value.slice(separator+1));
  const subject=parameters.get('subject');
  if(!subject||!Object.hasOwn(subjects,subject))return value;
  parameters.set('subject',subjects[subject][language]);
  return value.slice(0,separator+1)+parameters.toString();
}

export function siteInvitationMail(language:SiteLanguage,role:string,url:string) {
  const subject={fr:'Invitation à rejoindre Zentra',de:'Einladung zu Zentra',it:'Invito a partecipare a Zentra',en:'Invitation to join Zentra'}[language];
  const body={
    fr:`Bonjour,\n\nVous êtes invité(e) à rejoindre notre entreprise sur Zentra avec le rôle « ${role} ».\n\nOuvrez ce lien sécurisé avant son expiration :\n${url}\n\nÀ bientôt.`,
    de:`Guten Tag,\n\nSie sind eingeladen, unserem Unternehmen auf Zentra mit der Rolle «${role}» beizutreten.\n\nÖffnen Sie diesen sicheren Link, bevor er abläuft:\n${url}\n\nBis bald.`,
    it:`Buongiorno,\n\nSiete invitati a unirvi alla nostra azienda su Zentra con il ruolo «${role}».\n\nAprite questo link sicuro prima della sua scadenza:\n${url}\n\nA presto.`,
    en:`Hello,\n\nYou are invited to join our company on Zentra with the role “${role}”.\n\nOpen this secure link before it expires:\n${url}\n\nSee you soon.`,
  }[language];
  return {subject,body};
}
