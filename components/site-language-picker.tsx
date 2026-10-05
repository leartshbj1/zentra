'use client';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import { SITE_LANGUAGES, SITE_LANGUAGE_NAMES, isSiteLanguage, localizedSiteUrl } from '@/lib/site-language';
import { currentSiteLanguage, siteText } from '@/lib/site-language-client';

export function SiteLanguagePicker() {
  const [changing, setChanging] = useState(false);
  // SSR uses the server adapter, the browser reads the same lang from the initial HTML.
  const language = currentSiteLanguage();
  return <label className="site-language-picker">
    <Languages size={17} aria-hidden="true" />
    <span className="sr-only">{siteText('Langue du site')}</span>
    <select aria-label={siteText('Langue du site')} value={language} disabled={changing}
      onChange={event => {
        if (!isSiteLanguage(event.currentTarget.value)) return;
        setChanging(true);
        window.location.assign(localizedSiteUrl(window.location.href, event.currentTarget.value));
      }}>
      {SITE_LANGUAGES.map(value => <option value={value} key={value}>{SITE_LANGUAGE_NAMES[value]}</option>)}
    </select>
  </label>;
}
