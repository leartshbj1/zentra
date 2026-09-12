// Development-only: visual tests consume PDFs produced by the native renderer.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import StyledDocumentPreview from '../src/StyledDocumentPreview';
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
  const response = await fetch(`/native-design-fixture/${input.kind}-${input.style.composition?.fontFamily || input.style.layout}.pdf`);
  if (!response.ok) throw new Error('Run the native example fixture before visual testing.');
  return [...new Uint8Array(await response.arrayBuffer())];
};
desktopApi.exportDocumentDesignExample = async input => {
  sessionStorage.setItem('design-export', JSON.stringify(input));
  sessionStorage.setItem('design-export-count', String(Number(sessionStorage.getItem('design-export-count') || 0) + 1));
  if (sessionStorage.getItem('design-export-mode') === 'error') throw new Error('Le dossier choisi est indisponible. Choisissez un autre emplacement.');
  if (sessionStorage.getItem('design-export-mode') === 'share-error') return { path: 'example.pdf', deliveryWarning: 'Le PDF a été créé, mais le partage n’a pas abouti.' };
  return { path: 'example.pdf' };
};
desktopApi.shareExistingExport = async path => {
  sessionStorage.setItem('design-share-path', path);
  const count = Number(sessionStorage.getItem('design-share-count') || 0) + 1;
  sessionStorage.setItem('design-share-count', String(count));
  if (count === 1) throw new Error('Partage indisponible');
};
const previewKind = new URLSearchParams(location.search).get('preview') as 'quotes' | 'invoices' | 'payslips' | null;
let previewAttempts = 0;
desktopApi.documentPdfPreview = async (kind, id) => {
  sessionStorage.setItem('document-preview-request', JSON.stringify({ kind, id, attempts: ++previewAttempts }));
  if (previewAttempts === 1) throw new Error('Le document est momentanément indisponible. Réessayez.');
  const response = await fetch(`/native-design-fixture/${kind}-courier.pdf`);
  return [...new Uint8Array(await response.arrayBuffer())];
};
desktopApi.exportSalesDocumentPdf = async (kind, id, name) => { sessionStorage.setItem('document-preview-export', JSON.stringify({ kind,id,name })); return { path:'example.pdf', pages:2, finalDocument:false, hasQr:false, documentType:'quote' }; };
desktopApi.exportPayslipPdf = async (id, name) => { sessionStorage.setItem('document-preview-export', JSON.stringify({ kind:'payslips',id,name })); return { path:'example.pdf', pages:2, finalDocument:false }; };
function PreviewHarness() {
  const [open,setOpen]=useState(true);
  return open && previewKind ? <StyledDocumentPreview kind={previewKind} id="fixture-document" title="Document personnalisé" onClose={()=>setOpen(false)} /> : <p role="status">Aperçu fermé.</p>;
}
function Harness() {
  const [settings, setSettings] = useState<AppSettings>(() => JSON.parse(localStorage.getItem('design-settings') || 'null') || { ...initialOnboardingSettings, organization: { ...initialOnboardingSettings.organization, legalName: 'Atelier du Léman Sàrl', vatRegistered: true } });
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Explicit fixture events model settings refreshed elsewhere and a write lock.
    if (!new URLSearchParams(location.search).has('tools')) return;
    const update = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (typeof detail.busy === 'boolean') setBusy(detail.busy);
      if (detail.settings) setSettings(previous => {
        const next = { ...previous, ...detail.settings };
        sessionStorage.setItem('design-draft', JSON.stringify(next)); return next;
      });
    };
    window.addEventListener('design-fixture-update', update);
    return () => window.removeEventListener('design-fixture-update', update);
  }, []);
  return <main style={{ padding: 'clamp(12px,3vw,40px)', maxWidth: 1300, margin: 'auto' }}><DocumentDesignStudio settings={settings} onChange={next => { sessionStorage.setItem('design-draft', JSON.stringify(next)); setSettings(next); setSaved(false); }} busy={busy} onSave={() => { localStorage.setItem('design-settings', JSON.stringify(settings)); setSaved(true); }} />{saved && <p role="status">Présentations enregistrées.</p>}</main>;
}
createRoot(document.getElementById('root')!).render(previewKind ? <PreviewHarness /> : <Harness />);
