// Development-only: visual tests consume PDFs produced by the native renderer.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DocumentDesignStudio } from '../src/DocumentDesignStudio';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { desktopApi } from '../src/bridge';
import type { AppSettings } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';

desktopApi.documentDesignExample = async input => {
  sessionStorage.setItem('design-request', JSON.stringify(input));
  if (input.style.footer === 'Erreur de recette') throw new Error('Exemple momentanément indisponible.');
  const response = await fetch(`/native-design-fixture/${input.kind}-${input.style.layout}.pdf`);
  if (!response.ok) throw new Error('Run the native example fixture before visual testing.');
  return [...new Uint8Array(await response.arrayBuffer())];
};
desktopApi.exportDocumentDesignExample = async input => {
  sessionStorage.setItem('design-export', JSON.stringify(input));
  return 'example.pdf';
};
function Harness() {
  const [settings, setSettings] = useState<AppSettings>(() => JSON.parse(localStorage.getItem('design-settings') || 'null') || { ...initialOnboardingSettings, organization: { ...initialOnboardingSettings.organization, legalName: 'Atelier du Léman Sàrl', vatRegistered: true } });
  const [saved, setSaved] = useState(false);
  return <main style={{ padding: 'clamp(12px,3vw,40px)', maxWidth: 1300, margin: 'auto' }}><DocumentDesignStudio settings={settings} onChange={next => { setSettings(next); setSaved(false); }} busy={false} onSave={() => { localStorage.setItem('design-settings', JSON.stringify(settings)); setSaved(true); }} />{saved && <p role="status">Présentations enregistrées.</p>}</main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
