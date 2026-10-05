import { AlertTriangle, Download } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { diagnosticsApi } from './diagnostics';
import { ErrorDetails } from './ErrorGuidance';
import { useAppLanguage } from './language';
import { Button } from './ui';

const copy = {
  fr: { title: 'Récupération locale à terminer', message: 'Zentra n’a pas pu terminer la récupération de l’espace local. L’espace reste fermé pour protéger les fichiers encore présents.', action: 'Fermez puis rouvrez Zentra. Si ce message revient, exportez le diagnostic pour obtenir de l’aide.', export: 'Exporter le diagnostic', exporting: 'Export du diagnostic…', exported: 'Diagnostic exporté.', failed: 'Le diagnostic n’a pas pu être exporté. Vérifiez le stockage disponible puis réessayez l’export.' },
  de: { title: 'Lokale Wiederherstellung abschließen', message: 'Zentra konnte die Wiederherstellung des lokalen Arbeitsbereichs nicht abschließen. Der Arbeitsbereich bleibt geschlossen, um die noch vorhandenen Dateien zu schützen.', action: 'Schließen Sie Zentra und öffnen Sie es erneut. Wenn diese Meldung wieder erscheint, exportieren Sie das Diagnoseprotokoll, um Hilfe zu erhalten.', export: 'Diagnose exportieren', exporting: 'Diagnose wird exportiert…', exported: 'Diagnose exportiert.', failed: 'Die Diagnose konnte nicht exportiert werden. Prüfen Sie den verfügbaren Speicher und versuchen Sie den Export erneut.' },
  it: { title: 'Completare il ripristino locale', message: 'Zentra non ha potuto completare il ripristino dello spazio locale. Lo spazio resta chiuso per proteggere i file ancora presenti.', action: 'Chiudi e riapri Zentra. Se questo messaggio ricompare, esporta la diagnostica per ricevere assistenza.', export: 'Esporta diagnostica', exporting: 'Esportazione della diagnostica…', exported: 'Diagnostica esportata.', failed: 'Non è stato possibile esportare la diagnostica. Controlla lo spazio disponibile e riprova l’esportazione.' },
  en: { title: 'Complete local recovery', message: 'Zentra could not complete recovery of the local workspace. The workspace remains closed to protect the files still present.', action: 'Close and reopen Zentra. If this message returns, export diagnostics to get help.', export: 'Export diagnostics', exporting: 'Exporting diagnostics…', exported: 'Diagnostics exported.', failed: 'Diagnostics could not be exported. Check available storage, then retry the export.' },
};

/** No LocalStore actions, profile paths, recovery replay or destructive actions. */
export function StartupRecoveryPanel({ error, incidentCode }: { error: Error; incidentCode?: string }) {
  const c = copy[useAppLanguage()];
  const [busy, setBusy] = useState(false);
  const [exportedPath, setExportedPath] = useState('');
  const [exportError, setExportError] = useState<unknown>(null);
  const flight = useRef(false);
  const revision = useRef(0);
  useEffect(() => () => { ++revision.current; }, []);

  async function exportDiagnostics() {
    if (flight.current) return;
    flight.current = true;
    const ticket = ++revision.current;
    setBusy(true);
    setExportError(null);
    setExportedPath('');
    try {
      // This existing API flushes the safe log before exporting, and can refuse
      // when recent events cannot be retained. It never requires LocalStore.
      const file = await diagnosticsApi.export();
      if (ticket === revision.current) setExportedPath(file);
    } catch (reason) {
      if (ticket === revision.current) setExportError(reason);
    } finally {
      flight.current = false;
      if (ticket === revision.current) setBusy(false);
    }
  }

  return <section className="error-panel error-guidance" data-startup-recovery>
    <div className="error-guidance__message" role="alert">
      <AlertTriangle size={22} aria-hidden="true" />
      <div><h1>{c.title}</h1><p>{c.message}</p><p className="error-guidance__recovery">{c.action}</p></div>
    </div>
    <ErrorDetails error={error} incidentCode={incidentCode} />
    <div className="error-guidance__actions">
      <Button type="button" autoFocus variant="secondary" disabled={busy} onClick={() => void exportDiagnostics()}>
        <Download size={16} aria-hidden="true" />{busy ? c.exporting : c.export}
      </Button>
    </div>
    {exportedPath && <div className="diagnostics-export"><p role="status">{c.exported}</p><code>{exportedPath}</code></div>}
    {exportError !== null && <div><p role="alert">{c.failed}</p><ErrorDetails error={exportError} /></div>}
  </section>;
}
