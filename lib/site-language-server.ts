import { headers } from 'next/headers';
import { isSiteLanguage, SITE_LANGUAGE_HEADER, SITE_LANGUAGE_TAGS, SITE_PATH_HEADER, SITE_LANGUAGES, localizedSiteUrl, resolveSiteLanguage } from './site-language';
import { translateSiteUi, translateSiteMetadata } from './site-copy';
import { isPrivateSearchPath } from './seo-indexing';
import { translateSiteCount, type SiteCountKind } from './site-count-copy';
import { localizedSiteMailto } from './site-service-copy';
import { siteNumberFormatter, localizedSiteString } from './site-number-format';

export async function getSiteLanguage() {
  const value = (await headers()).get(SITE_LANGUAGE_HEADER);
  return isSiteLanguage(value) ? value : 'fr';
}

/** Vinext beta.5 decorates its request-local Promise with synchronous header getters.
 * The build-time UI adapter uses this only while rendering; module-level data stays raw.
 * Both client SSR and RSC use the same isolated request context. */
export function currentSiteLanguage() {
  try {
  const requestHeaders = headers();
  void requestHeaders.catch(() => {});
  const value = (requestHeaders as unknown as Headers).get?.(SITE_LANGUAGE_HEADER);
  if(isSiteLanguage(value)) return value;
  // Checkout/API requests retain the language choice in their first-party cookie.
  const readable=requestHeaders as unknown as Headers;
  return resolveSiteLanguage(new Request('https://www.zentraapp.ch',{headers:{cookie:readable.get?.('cookie')||'','accept-language':readable.get?.('accept-language')||''}}));
  } catch { return 'fr'; }
}
export const siteText = <T,>(value: T): T => translateSiteUi(value, currentSiteLanguage());
export const siteLocale = () => SITE_LANGUAGE_TAGS[currentSiteLanguage()];
export const siteMailto = (value:string) => localizedSiteMailto(value,currentSiteLanguage());
export const siteNumberFormat = (options?:Intl.NumberFormatOptions) => siteNumberFormatter(currentSiteLanguage(),options);
export const siteLocalizedString = (value:Parameters<typeof localizedSiteString>[0],options?:Parameters<typeof localizedSiteString>[2]) => localizedSiteString(value,currentSiteLanguage(),options);
export const siteCount = (kind:SiteCountKind,count:number) => translateSiteCount(kind,count,currentSiteLanguage());
export function siteMetadata<T>(value:T):T {
  const language=currentSiteLanguage();
  const translated=translateSiteMetadata(value,language);
  const requestHeaders=headers(); void requestHeaders.catch(()=>{});
  const path=(requestHeaders as unknown as Headers).get?.(SITE_PATH_HEADER);
  if(!path||isPrivateSearchPath(path)||!translated||typeof translated!=='object')return translated;
  const record=translated as Record<string,unknown>;
  return {...record,alternates:{...(record.alternates as object||{}),canonical:localizedSiteUrl(path,language),languages:Object.fromEntries(SITE_LANGUAGES.map(lang=>[SITE_LANGUAGE_TAGS[lang],localizedSiteUrl(path,lang)]))}} as T;
}
