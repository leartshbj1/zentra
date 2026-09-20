// Development-only fixture; never included in the application build.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationSetup, BankClassification } from '../src/AutomationControls';
import { AutomationCatalogMapping } from '../src/AutomationCatalogMapping';
import {
  setAppLanguage,
  useAppLanguage,
  languageNames,
  type AppLanguage,
} from '../src/language';
import '../src/styles.css';
import '../src/workspace-design.css';
import '../src/mobile.css';
import '../src/dark.generated.css';
import '../src/dark.css';
import { setAppearance, type Appearance } from '../src/appearance';
let mode = 'suggest';
Object.assign(window, {
  __TAURI_INTERNALS__: {
    invoke: async (
      command: string,
      args: { data?: Record<string, unknown> },
    ) => {
      if (command !== 'automation_request') return;
      if (!args.data)
        return {
          organizationId: 'qa',
          active: true,
          available: ['transaction_classification', 'import_mapping'],
          settings: {
            enabled: true,
            consent: true,
            flags: ['transaction_classification', 'import_mapping'],
            mode,
            thresholds: { medium: 0.65, high: 0.9 },
          },
        };
      if (args.data.action === 'feedback') return { recorded: true };
      return {
        id: String(args.data.requestId),
        status:
          mode === 'shadow'
            ? 'shadow'
            : mode === 'offline'
              ? 'manual'
              : 'suggestion',
        band: 'high',
        ...(mode === 'suggest'
          ? {
              choices:
                args.data.feature === 'import_mapping'
                  ? {
                      column_0: 'sku',
                      column_1: 'name',
                      column_2: 'salesPriceCents',
                    }
                  : { category: 'material' },
            }
          : {}),
      };
    },
  },
});
const source = {
  fileName: 'Exemple.csv',
  sheetName: 'CSV',
  headerIndex: 0,
  rows: [
    ['Code', 'Nom du produit', 'Tarif'],
    ['P1', 'Matériel de démonstration', '12.50'],
  ].map((row) => row.map((value) => ({ value }))),
};
function Harness() {
  const [variant, setVariant] = useState('suggest'),
    [notice, setNotice] = useState('');
  const language = useAppLanguage();
  return (
    <main style={{ maxWidth: 760, margin: '0 auto', padding: 16 }}>
      <h1>Zentra Automation · Recette</h1>
      <label>
        Langue{' '}
        <select
          value={language}
          onChange={(e) => setAppLanguage(e.target.value as AppLanguage)}
        >
          {Object.entries(languageNames).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        Thème{' '}
        <select
          onChange={(e) => {
            setAppearance(e.target.value as Appearance);
          }}
        >
          <option value="light">Clair</option>
          <option value="dark">Sombre</option>
        </select>
      </label>
      <label>
        Scénario{' '}
        <select
          value={variant}
          onChange={(e) => {
            mode = e.target.value;
            setVariant(mode);
          }}
        >
          <option value="suggest">Suggestion</option>
          <option value="shadow">Observation</option>
          <option value="offline">Indisponible</option>
        </select>
      </label>
      <AutomationSetup
        onContinue={() => setNotice('Suite de la configuration')}
        onSkip={() => setNotice('Configuration poursuivie sans option')}
      />
      <BankClassification
        key={variant}
        context={{ text: 'Matériel pour le projet' }}
        identity={variant}
      />
      <details open>
        <summary>Import de catalogue</summary>
        <AutomationCatalogMapping
          key={variant + 'map'}
          source={source}
          disabled={false}
          onPrepared={(v) =>
            setNotice(`${v.rows.length} ligne prête à vérifier`)
          }
        />
      </details>
      <output>{notice}</output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Harness />);
