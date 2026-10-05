import type { SiteLanguage } from './site-language';
type Dictionary = Record<string, string>;
export const normalizeSiteCopy = (value: string) => value.replace(/\s+/g, ' ').trim();
const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternCache = new WeakMap<Dictionary, {key:string;expression:RegExp;slots:string[]}[]>();
function dictionaryPatterns(dictionary: Dictionary) {
  let patterns = patternCache.get(dictionary);
  if (!patterns) {
    patterns = Object.keys(dictionary).filter(key => /\{\{\d+\}\}/.test(key)).map(key => ({
      key, expression: new RegExp('^' + key.split(/(\{\{\d+\}\})/).map(part => /^\{\{\d+\}\}$/.test(part) ? '([\\s\\S]{0,2000}?)' : escapePattern(part).replace(/\s+/g,'\\s+')).join('') + '$', 'u'),
      slots: [...key.matchAll(/\{\{(\d+)\}\}/g)].map(match => match[1]),
    })).sort((a,b) => b.key.length-a.key.length);
    patternCache.set(dictionary, patterns);
  }
  return patterns;
}
function renderTemplate(key:string, translated:string, values:Record<string,string>, language:SiteLanguage) {
  const nouns:Record<string,Record<Exclude<SiteLanguage,'fr'>,[string,string]>>={
    personne:{de:['Person','Personen'],it:['persona','persone'],en:['person','people']},
    minute:{de:['Minute','Minuten'],it:['minuto','minuti'],en:['minute','minutes']},
    démarchage:{de:['Werbeanfrage','Werbeanfragen'],it:['contatto commerciale','contatti commerciali'],en:['sales enquiry','sales enquiries']},
    rappel:{de:['Erinnerung','Erinnerungen'],it:['promemoria','promemoria'],en:['reminder','reminders']},
    essai:{de:['Versuch','Versuche'],it:['tentativo','tentativi'],en:['attempt','attempts']},
  };
  if(language!=='fr')for(const [noun,forms] of Object.entries(nouns)){
    for(const match of key.matchAll(new RegExp(noun+'\\{\\{(\\d+)\\}\\}','g'))){
      const slot=match[1];if(!['s',''].includes(values[slot]))continue;
      const [singular,plural]=forms[language];
      const aliases=noun==='démarchage'&&language==='de'?[singular,plural,'Akquise']:[singular,plural];
      translated=translated.replace(new RegExp('(?:'+aliases.map(escapePattern).join('|')+')\\{\\{'+slot+'\\}\\}','gu'),values[slot]==='s'?plural:singular);
    }
  }
  return translated.replace(/\{\{(\d+)\}\}/g,(_,slot:string)=>values[slot]??'{{'+slot+'}}');
}
export function translateSiteCopy(value: string, language: SiteLanguage, dictionary: Dictionary): string {
  if (language === 'fr' || !value) return value;
  const key = normalizeSiteCopy(value);
  let translated = Object.prototype.hasOwnProperty.call(dictionary, key) ? dictionary[key] : undefined;
  if (!translated && key.length <= 10000) for (const pattern of dictionaryPatterns(dictionary)) {
    const match = pattern.expression.exec(value.trim()); if (!match) continue;
    const values = Object.fromEntries(pattern.slots.map((slot,i) => [slot,match[i+1]]));
    translated = renderTemplate(pattern.key,dictionary[pattern.key],values,language); break;
  }
  return translated ? (value.match(/^\s*/)?.[0] || '') + translated + (value.match(/\s*$/)?.[0] || '') : value;
}
export function translateSiteUi<T>(value:T, language:SiteLanguage, dictionary:Dictionary):T {
  if(typeof value==='string')return translateSiteCopy(value,language,dictionary) as T;
  if(Array.isArray(value))return value.map(item=>typeof item==='string'?translateSiteCopy(item,language,dictionary):item) as T;
  return value;
}
const metadataFields=new Set(['title','description','default','absolute','template','alt','keywords']);
function socialImage(value:unknown,language:SiteLanguage):unknown {
  if(typeof value==='string')return value.replace(/\/og\.png(?=$|[?#])/,'/og/'+language+'.png');
  if(Array.isArray(value))return value.map(item=>socialImage(item,language));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,key==='url'?socialImage(item,language):item]));
  return value;
}
export function translateSiteMetadata<T>(value:T, language:SiteLanguage, dictionary:Dictionary):T {
  if(Array.isArray(value))return value.map(item=>translateSiteMetadata(item,language,dictionary)) as T;
  if(!value||typeof value!=='object'||value instanceof URL)return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
    metadataFields.has(key)&&typeof item==='string'?translateSiteCopy(item,language,dictionary)
    :metadataFields.has(key)&&Array.isArray(item)?item.map(entry=>typeof entry==='string'?translateSiteCopy(entry,language,dictionary):translateSiteMetadata(entry,language,dictionary))
    :key==='images'?socialImage(translateSiteMetadata(item,language,dictionary),language)
    :key==='locale'?language==='en'?'en_GB':language+'_CH'
    :item&&typeof item==='object'?translateSiteMetadata(item,language,dictionary):item])) as T;
}
export function translateSiteStructuredData<T>(value:T, language:SiteLanguage, dictionary:Dictionary):T {
  if(Array.isArray(value))return value.map(item=>translateSiteStructuredData(item,language,dictionary)) as T;
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
    key==='inLanguage'?language+'-CH':typeof item==='string'&&['name','description','text'].includes(key)?translateSiteCopy(item,language,dictionary)
    :item&&typeof item==='object'?translateSiteStructuredData(item,language,dictionary):item])) as T;
}
