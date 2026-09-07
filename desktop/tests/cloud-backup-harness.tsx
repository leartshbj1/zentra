// Isolated UI fixture. No connection to a customer account or native database.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudBackupPanel } from '../src/CloudBackupPanel';
import { desktopApi } from '../src/bridge';
import type { CloudBackupState } from '../src/cloudBackup';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/experience.css';
const query = new URLSearchParams(location.search);
const mode = query.get('mode');
let failOnce = mode === 'interrupted';
const id = 'ac513271-44d4-47e5-8830-2bb40cd5dced';
let state: CloudBackupState = {
  enabled: false,
  connected: true,
  running: false,
  last_success_at: null,
  backups: [
    {
      backup_id: id,
      installation_id: '55af29dd-fdaa-4993-ae78-17f9ca220e51',
      created_at: '2026-09-08T07:30:00Z',
      completed_at: '2026-09-08T07:31:00Z',
      app_version: '1.45.0',
      size_bytes: 42 * 1024 * 1024,
      state: 'complete',
    },
  ],
};
if (mode === 'offline')
  state = {
    ...state,
    connected: false,
    error: 'Hors ligne. Le coffre sera accessible au retour du réseau.',
  };
if (mode === 'restricted')
  state = {
    ...state,
    connected: false,
    error:
      'Les sauvegardes complètes sont réservées au titulaire et aux administrateurs.',
  };
desktopApi.getCloudBackupState = async () => structuredClone(state);
desktopApi.setCloudBackupEnabled = async (enabled) => {
  state.enabled = enabled;
  return structuredClone(state);
};
desktopApi.runCloudBackup = async () => {
  if (failOnce) {
    failOnce = false;
    state.pending_id = id;
    state.last_error = 'Envoi interrompu. La copie locale est conservée.';
    throw new Error(state.last_error);
  }
  state = {
    ...state,
    last_success_at: '2026-09-08T09:40:00Z',
    pending_id: null,
    last_error: null,
  };
  return structuredClone(state);
};
desktopApi.deleteCloudBackup = async (backupId) => {
  state.backups = state.backups?.filter((b) => b.backup_id !== backupId);
};
desktopApi.cancelCloudBackup = async () => {
  state.pending_id = null;
  state.enabled = false;
  state.last_error = null;
};
function Harness() {
  const [restored, setRestored] = useState('');
  return (
    <main style={{ maxWidth: 900, margin: '0 auto', padding: '24px 16px' }}>
      <p style={{ marginBottom: 20, fontSize: 12 }}>
        Recette isolée · données fictives
      </p>
      <CloudBackupPanel
        recoveryOnly={mode === 'recovery'}
        onRestore={async (value) => {
          setRestored(value);
        }}
      />
      {restored ? (
        <p role="status">Restauration demandée : {restored}</p>
      ) : null}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
