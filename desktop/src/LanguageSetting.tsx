import { useState } from 'react';
import { Languages, Check } from 'lucide-react';
import { appLanguages, languageNames, setAppLanguage, t, useAppLanguage } from './language';
import './language.css';

export function LanguageSetting({ compact = false }: { compact?: boolean }) {
  const language = useAppLanguage();
  const [saved, setSaved] = useState<boolean | null>(null);
  return <section className={`language-setting${compact ? ' language-setting--compact' : ''}`} aria-label={t('Langue de l’application')}>
    <header><Languages size={21} aria-hidden="true" /><div><h2>{t('Choisissez votre langue')}</h2><p>{t('Vous pourrez la changer à tout moment dans les paramètres.')}</p></div></header>
    <div className="language-setting__choices" role="group" aria-label={t('Langue de l’application')}>
      {appLanguages.map(value => <button key={value} type="button" lang={value} aria-pressed={value === language} onClick={() => setSaved(setAppLanguage(value))}><span>{languageNames[value]}</span>{value === language && <Check size={17} aria-hidden="true" />}</button>)}
    </div>
    {language !== 'fr' && <p className="language-setting__preview">{t('La traduction de l’ensemble de Zentra est en préparation. Certains écrans et PDF sont encore en français.')}</p>}
    {saved !== null && <p role={saved ? 'status' : 'alert'}>{saved ? t('Langue enregistrée sur cet appareil.') : t('La langue est changée pour cette session, mais cet appareil ne peut pas enregistrer votre préférence. Réessayez après avoir libéré de l’espace.')}</p>}
  </section>;
}
