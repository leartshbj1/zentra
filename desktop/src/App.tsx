import { useCallback, useEffect, useState } from 'react';
import { HardHat, LoaderCircle } from 'lucide-react';
import { desktopApi } from './bridge';
import { Onboarding } from './Onboarding';
import { WorkspaceApp } from './WorkspaceApp';
import type { AppSettings, Workspace } from './types';
import { Button, ErrorPanel } from './ui';

export function App() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setWorkspace(await desktopApi.loadWorkspace());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'L’espace local n’a pas pu être ouvert.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <main className="splash-screen">
        <div className="splash-logo"><HardHat size={28} /></div>
        <h1>HelviChantier</h1>
        <p>Ouverture de votre espace local sécurisé…</p>
        <LoaderCircle className="spin" size={22} />
      </main>
    );
  }

  if (error || !workspace) {
    return (
      <main className="fatal-screen">
        <div className="splash-logo"><HardHat size={28} /></div>
        <ErrorPanel message={error || 'Aucune donnée locale n’a été retournée.'} />
        <Button onClick={() => void load()}>Réessayer</Button>
      </main>
    );
  }

  if (!workspace.onboardingCompleted || !workspace.settings) {
    return (
      <Onboarding
        onComplete={async (settings: AppSettings) => setWorkspace(await desktopApi.completeOnboarding(settings))}
        onRestore={async (path: string) => setWorkspace(await desktopApi.restoreBackup(path))}
      />
    );
  }

  return <WorkspaceApp workspace={workspace} setWorkspace={setWorkspace} />;
}

