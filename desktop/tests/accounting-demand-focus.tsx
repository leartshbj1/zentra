// Local browser fixture only. The caller installs synthetic APIs before mounting.
import { createRoot } from 'react-dom/client';
import { AccountingScreen } from '../src/AccountingScreen';
import { desktopApi } from '../src/bridge';
import type { AccountingEntryFocus } from '../src/PaymentAccountingProofs';

export async function mountFocusTest(focusEntry: AccountingEntryFocus | null) {
  const workspace = await desktopApi.loadWorkspace();
  const harness = document.getElementById('root');
  const wasHidden = harness?.hidden ?? false;
  if (harness) harness.hidden = true;
  const container = document.createElement('div');
  container.id = 'accounting-demand-focus';
  document.body.append(container);
  const root = createRoot(container);
  let handled = 0;
  root.render(<AccountingScreen workspace={workspace} focusEntry={focusEntry} onFocusHandled={() => { handled++; }} onWorkspaceChange={() => { throw new Error('Read-only fixture must not modify workspace'); }} />);
  return { handled: () => handled, dispose: () => { root.unmount(); container.remove(); if (harness) harness.hidden = wasHidden; } };
}
