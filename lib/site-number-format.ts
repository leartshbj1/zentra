import { SITE_LANGUAGE_TAGS, type SiteLanguage } from './site-language';

/** Node and browser ICU versions disagree on Swiss thousands separators.
 * Normalising number parts keeps server and client hydration identical. */
export function siteNumberFormatter(language:SiteLanguage,options?:Intl.NumberFormatOptions) {
  const formatter=new Intl.NumberFormat(SITE_LANGUAGE_TAGS[language],{useGrouping:'always',...options});
  return {format(value:number|bigint){return formatter.formatToParts(value).map(part=>
    part.type==='group'?(language==='en'?',':'’'):part.type==='decimal'?(language==='fr'?',':'.'):part.value
  ).join('');}};
}
export function localizedSiteString(value:{toLocaleString(...args:any[]):string}|number|bigint,language:SiteLanguage,options?:Intl.NumberFormatOptions|Intl.DateTimeFormatOptions):string {
  if(typeof value==='number'||typeof value==='bigint')return siteNumberFormatter(language,options as Intl.NumberFormatOptions).format(value);
  return value.toLocaleString(SITE_LANGUAGE_TAGS[language],options);
}
