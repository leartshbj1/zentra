// Development-only fixture: real overview/dialog in the existing app shell.
// All persistence is replaced with an in-memory workspace before mounting.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FinanceOverview } from '../src/FinanceOverview';
import { desktopApi } from '../src/bridge';
import type { AppSettings } from '../src/types';

export async function mountFinanceLanguageTest() {
  const initial = await desktopApi.loadWorkspace();
  const report = await desktopApi.getIncomeStatement({});
  const continuity = await desktopApi.getAccountingContinuity();
  let latest = structuredClone(initial);
  const records = { sections: [] as string[], writes: [] as AppSettings[], attempts: 0, installations: 0, failNext: false };
  desktopApi.loadWorkspace = async () => structuredClone(latest);
  desktopApi.saveSettings = async settings => {
    records.attempts++;
    if (records.failNext) { records.failNext = false; throw undefined; }
    records.writes.push(structuredClone(settings));
    latest = { ...latest, settings: structuredClone(settings) };
    return structuredClone(latest);
  };
  const original = document.querySelector<HTMLElement>('.accounting-screen')!;
  const previousDisplay = original.style.display;
  original.style.display = 'none';
  const container = document.createElement('div');
  container.id = 'finance-language-fixture';
  original.after(container);
  const root = createRoot(container);
  type Scenario = 'ready' | 'readonly' | 'setup' | 'loading' | 'multicurrency' | 'loss' | 'anomalies';
  function Journey({ scenario }: { scenario: Scenario }) {
    const [workspace, setWorkspace] = useState(initial);
    return <div className="accounting-screen stack-layout"><FinanceOverview
      workspace={workspace}
      income={{ ...report, revenueCents: 123456, expenseCents: 4567, profitCents: scenario === 'loss' ? -118889 : 118889, currency: { ...report.currency, singleCurrency: scenario !== 'multicurrency', exchangeRatesApplied: false } }}
      continuity={{ ...continuity, enabled: scenario !== 'setup', mappingReady: scenario !== 'setup', journalEntryCount: scenario === 'setup' ? 0 : 1, totalAnomalies: scenario === 'anomalies' ? 1 : 0, totalMissing: 0, starterAvailable: true }}
      busy={scenario === 'loading'} readOnly={scenario === 'readonly'} periodLabel="QA · 01.01.2026 – 31.12.2026"
      onSection={section => { records.sections.push(section); }} onWorkspaceChange={setWorkspace}
      onInstallStarter={async () => { records.installations++; }}
    /></div>;
  }
  const render = (scenario: Scenario = 'ready') => root.render(<Journey key={scenario} scenario={scenario} />);
  render();
  return { records, render, latest: () => structuredClone(latest), initial: structuredClone(initial), dispose: () => { root.unmount(); container.remove(); original.style.display = previousDisplay; } };
}
