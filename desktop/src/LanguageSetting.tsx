import { Languages, Check } from 'lucide-react';
import { appLanguages, languageNames, setAppLanguage, t, useLanguageState } from './language';
import { LanguageStatus } from './LanguageStatus';
import './language.css';

export function LanguageSetting({ compact = false, embedded = false }: { compact?: boolean; embedded?: boolean }) {
  const { language, pending } = useLanguageState();
  return <section className={`language-setting${compact ? ' language-setting--compact' : ''}`} aria-label={t('Langue de l’application')}>
    {!embedded && <header><Languages size={21} aria-hidden="true" /><div><h2>{t('Choisissez votre langue')}</h2><p>{t('Vous pourrez la changer à tout moment dans les paramètres.')}</p></div></header>}
    <div className="language-setting__choices" role="group" aria-label={t('Langue de l’application')}>
      {appLanguages.map(value => <button key={value} type="button" lang={value} aria-pressed={value === language} aria-busy={value === pending} onClick={() => { void setAppLanguage(value).catch(() => {}); }}><span>{languageNames[value]}</span>{value === language && <Check size={17} aria-hidden="true" />}</button>)}
    </div>
    {language !== 'fr' && <p className="language-setting__preview">{t('La traduction de l’ensemble de Zentra est en préparation. Certains écrans et PDF sont encore en français.')}</p>}
    <LanguageStatus confirm/>
  </section>;
}
