import { isSiteLanguage, SITE_LANGUAGE_TAGS } from './site-language';
import { translateSiteUi, translateSiteMetadata } from './site-copy-core';
import { translateSiteCount, type SiteCountKind } from './site-count-copy';
import { localizedSiteMailto } from './site-service-copy';
import { siteNumberFormatter, localizedSiteString } from './site-number-format';
let browserDictionary: Record<string,string> | undefined;
let dictionaryElement:HTMLElement|null = null;
let dictionaryLanguage = '';
function dictionary() {
  if(typeof document==='undefined')return {};
  const element=document.getElementById('zentra-site-copy');
  if(!element)return {};
  const language=element.dataset.siteLanguage||document.documentElement.lang;
  if(browserDictionary&&dictionaryElement===element&&dictionaryLanguage===language)return browserDictionary;
  const value:unknown=JSON.parse(element.textContent||'{}');
  browserDictionary=value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter((entry):entry is [string,string]=>typeof entry[1]==='string')):{};
  dictionaryElement=element; dictionaryLanguage=language;
  return browserDictionary;
}

export function currentSiteLanguage() {
  const value = typeof document === 'undefined' ? 'fr' : (document.getElementById('zentra-site-copy')?.dataset.siteLanguage||document.documentElement.lang).split('-')[0];
  return isSiteLanguage(value) ? value : 'fr';
}
export const siteText = <T,>(value: T): T => translateSiteUi(value, currentSiteLanguage(), dictionary());
export const siteLocale = () => SITE_LANGUAGE_TAGS[currentSiteLanguage()];
export const siteMailto = (value:string) => localizedSiteMailto(value,currentSiteLanguage());
export const siteNumberFormat = (options?:Intl.NumberFormatOptions) => siteNumberFormatter(currentSiteLanguage(),options);
export const siteLocalizedString = (value:Parameters<typeof localizedSiteString>[0],options?:Parameters<typeof localizedSiteString>[2]) => localizedSiteString(value,currentSiteLanguage(),options);
export const siteCount = (kind:SiteCountKind,count:number) => translateSiteCount(kind,count,currentSiteLanguage());
export const siteMetadata = <T,>(value: T): T => translateSiteMetadata(value, currentSiteLanguage(), dictionary());
