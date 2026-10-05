declare module 'zentra:site-language' {
  export function siteCount(kind:import('./lib/site-count-copy').SiteCountKind,count:number):string;
  export function siteText<T>(value:T):T;
  export function siteLocale():string;
  export function siteMailto(value:string):string;
  export function siteNumberFormat(options?:Intl.NumberFormatOptions):{format(value:number|bigint):string};
  export function siteLocalizedString(value:{toLocaleString(...args:any[]):string}|number|bigint,options?:Intl.NumberFormatOptions|Intl.DateTimeFormatOptions):string;
  export function siteMetadata<T>(value:T):T;
  export function currentSiteLanguage():import('./lib/site-language').SiteLanguage;
}
