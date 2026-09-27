import { useEffect, type ReactNode } from 'react';
import { initializeAppLanguage, setAppLanguage, useLanguageState } from './language';
import { BrandWordmark } from './BrandMark';
import './language.css';

// Recovery must remain readable even when the requested language file could not be read.
const messages = {
  fr: { loading: 'Ouverture de votre langue…', failed: 'Cette langue n’a pas pu être ouverte. Votre saisie est conservée.', retry: 'Réessayer', session: 'Langue changée pour cette session. La préférence n’a pas pu être enregistrée sur cet appareil.', saved: 'Langue enregistrée sur cet appareil.', fallback: 'Continuer en français' },
  de: { loading: 'Sprache wird geöffnet…', failed: 'Diese Sprache konnte nicht geöffnet werden. Ihre Eingaben bleiben erhalten.', retry: 'Erneut versuchen', session: 'Sprache für diese Sitzung geändert. Die Einstellung konnte auf diesem Gerät nicht gespeichert werden.', saved: 'Sprache auf diesem Gerät gespeichert.', fallback: 'Auf Französisch fortfahren' },
  it: { loading: 'Apertura della lingua…', failed: 'Impossibile aprire questa lingua. I dati inseriti sono conservati.', retry: 'Riprova', session: 'Lingua modificata per questa sessione. Impossibile salvare la preferenza su questo dispositivo.', saved: 'Lingua salvata su questo dispositivo.', fallback: 'Continua in francese' },
  en: { loading: 'Opening your language…', failed: 'This language could not be opened. Your entries are preserved.', retry: 'Try again', session: 'Language changed for this session. The preference could not be saved on this device.', saved: 'Language saved on this device.', fallback: 'Continue in French' },
};

export function LanguageStatus({ confirm = false }: { confirm?: boolean }) {
  const state = useLanguageState();
  const language = state.failed ?? state.pending ?? state.language;
  const copy = messages[language];
  const text = state.pending ? copy.loading : state.failed ? copy.failed : state.persisted === false ? copy.session : confirm && state.persisted ? copy.saved : '';
  if (!text) return null;
  return <div className="language-feedback" lang={language}>
    <p role={state.failed || state.persisted === false ? 'alert' : 'status'}>{text}</p>
    {state.failed && <button type="button" onClick={() => { void setAppLanguage(state.failed!).catch(() => {}); }}>{copy.retry}</button>}
  </div>;
}

export function LanguageBoot({ children }: { children: ReactNode }) {
  const state = useLanguageState();
  useEffect(() => { void initializeAppLanguage().catch(() => {}); }, []);
  if (state.ready) return children;
  return <main className="language-boot">
    <BrandWordmark/>
    <LanguageStatus/>
    {state.failed && <button type="button" onClick={() => { void setAppLanguage('fr'); }}>{messages[state.failed].fallback}</button>}
  </main>;
}
