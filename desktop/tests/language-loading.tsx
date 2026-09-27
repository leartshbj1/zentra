// Synthetic local fixture. Real language components, no company storage or external account.
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { LanguageSetting } from '../src/LanguageSetting';
import { LanguageBoot } from '../src/LanguageStatus';
import { t, useAppLanguage } from '../src/language';
import '../src/appearance';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
import '../src/brand-identity.css';

function Draft() {
  useAppLanguage();
  const [value, setValue] = useState('');
  return <main className="desktop-app" data-experience="apple" style={{ maxWidth:720, padding:24, margin:'auto' }}>
    <h1>{t('Paramètres')}</h1><LanguageSetting/>
    <label style={{display:'grid',gap:8,marginTop:24}}>Saisie de recette · conservée lors du changement de langue<input aria-label="Saisie de recette" value={value} onChange={event=>setValue(event.target.value)}/></label>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><LanguageBoot><Draft/></LanguageBoot></StrictMode>);
