import type { SiteLanguage } from './site-language';
import { translateSiteUi as translateUi, translateSiteMetadata as translateMetadata } from './site-copy-core';
export { translateSiteStructuredData } from './site-copy-core';
import de from './site-copy/de.json';
import it from './site-copy/it.json';
import en from './site-copy/en.json';

const dictionaries: Record<Exclude<SiteLanguage, 'fr'>, Record<string, string>> = { de, it, en };
export const siteDictionary = (language: SiteLanguage) => language === 'fr' ? {} : dictionaries[language];
export const translateSiteUi = <T,>(value: T, language: SiteLanguage): T => translateUi(value, language, siteDictionary(language));
export const translateSiteMetadata = <T,>(value: T, language: SiteLanguage): T => translateMetadata(value, language, siteDictionary(language));
export const serializeSiteDictionary = (language: SiteLanguage) => JSON.stringify(siteDictionary(language))
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
