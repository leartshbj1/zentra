// Development-only fixture. No customer database or external service is contacted.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BexioImportPanel } from '../src/BexioImportPanel';
import { desktopApi } from '../src/bridge';
import { initialOnboardingSettings } from '../src/onboardingDraft';
import { setAppearance } from '../src/appearance';
import type { Workspace } from '../src/types';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import '../src/workspace-atelier.css';
setAppearance(
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light',
);
const settings = structuredClone(initialOnboardingSettings);
settings.organization.legalName = 'Atelier exemple SA';
let workspace = {
  settings,
  clients: [{ id: 'existing', name: 'Client existant' }],
  suppliers: [],
  catalogItems: [],
} as unknown as Workspace;
const qa = { calls: [] as unknown[], fail: false, refreshFail: false };
Object.assign(window, {
  __bexioQa: qa,
  __TAURI_INTERNALS__: {
    invoke: async (
      command: string,
      args: {
        input: {
          scope: string;
          entity: 'clients' | 'suppliers';
          rows: { line: number; data: { name: string } }[];
        };
      },
    ) => {
      if (command === 'bexio_import_scope') return 'fixture-company';
      if (command !== 'import_bexio_contacts')
        throw Error(`Unexpected command: ${command}`);
      if (args.input.scope !== 'fixture-company') throw Error('Wrong company');
      if (qa.fail) throw Error('Import refusé pour ce test.');
      qa.calls.push(structuredClone(args));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const rows = args.input.rows.map((row) => ({
        line: row.line,
        name: row.data.name,
        status: 'created',
      }));
      workspace = {
        ...workspace,
        [args.input.entity]: [
          ...workspace[args.input.entity],
          ...args.input.rows.map((row, index) => ({
            id: `fixture-${index}`,
            name: row.data.name,
          })),
        ],
      };
      return { created: rows.length, skipped: 0, rows };
    },
  },
});
desktopApi.loadWorkspace = async () => {
  if (qa.refreshFail) throw Error('Read unavailable');
  return structuredClone(workspace);
};
function Preview() {
  const [data, setData] = useState(workspace);
  return (
    <main
      style={{
        maxWidth: 1000,
        margin: 'auto',
        padding: '20px',
        minHeight: '100vh',
      }}
    >
      <p>Données fictives · aperçu d’import</p>
      <BexioImportPanel
        workspace={data}
        disabled={false}
        onWorkspace={setData}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
