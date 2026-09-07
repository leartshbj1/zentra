import { createRoot } from 'react-dom/client';
import { BackupRecoveryView } from '../../components/backup-recovery-view';
document.documentElement.style.setProperty('--font-geist-sans', 'Arial, sans-serif');
// This isolated fixture uses the real site's latest compiled styles and only
// fictitious records. It is not part of either production entry point.
const styleFiles = import.meta.glob('../../dist/client/_next/static/css/*.css', { query: '?url', eager: true, import: 'default', exhaustive: true });
for (const href of Object.values(styleFiles)) {
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = String(href); document.head.append(link);
}
const mode = new URLSearchParams(location.search).get('mode');
createRoot(document.getElementById('root')!).render(<BackupRecoveryView
  organizations={[{ organizationId: 'org_fixture', organizationName: 'Atelier du Léman — démonstration' }, { organizationId: 'org_other', organizationName: 'Deuxième entreprise fictive' }]}
  organizationId="org_fixture"
  signInPath={mode === 'login' ? '/connexion' : undefined}
  error={mode === 'error' ? 'Le coffre est momentanément inaccessible. Réessayez dans quelques instants ; aucune copie n’a été supprimée.' : undefined}
  backups={mode === 'empty' ? [] : [
    { backup_id: 'ac513271-44d4-47e5-8830-2bb40cd5dced', created_at: '2026-09-07T22:00:00Z', size_bytes: 6500123, app_version: '1.45.0', state: 'complete' },
    { backup_id: 'bc513271-44d4-47e5-8830-2bb40cd5dced', created_at: '2026-09-06T22:00:00Z', size_bytes: 5500123, app_version: '1.45.0', state: 'complete' },
    { backup_id: 'cc513271-44d4-47e5-8830-2bb40cd5dced', created_at: '2026-09-05T22:00:00Z', size_bytes: 3000123, app_version: '1.45.0', state: 'uploading' },
  ]}
/>);
