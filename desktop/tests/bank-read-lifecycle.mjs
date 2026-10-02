import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual WorkspaceApp, BankScreen and ClientForm; all bridge data is synthetic.
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5401';
const before = process.argv.includes('--before');
const beforeReceive = before || process.argv.includes('--before-receive');
const output = process.env.ZENTRA_QA_OUTPUT || join(tmpdir(), `zentra-bank-read-lifecycle-${before ? 'before' : beforeReceive ? 'before-receive' : 'after'}`);
await mkdir(output, { recursive: true });

async function navigate(page, screen) {
  await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill(screen);
  await page.locator('.navigation-palette__results button').filter({ has: page.getByText(screen, { exact: true }) }).click();
  await page.locator('.navigation-palette').waitFor({ state: 'detached' });
}

async function fixture(browser, result, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => result.errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || url.pathname.startsWith('/api/')) {
      result.blocked.push(url.origin + url.pathname);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto(`${origin}/tests/mobile-harness.html?finance=1&bank=1`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
  await page.evaluate(async () => {
    const api = window.__qaDesktopApi;
    await api.importCamtFile('releve-fictif.xml', false);
    window.__bankAuditStore = await api.loadWorkspace();
    window.__bankAuditEvents = [];
    api.loadWorkspace = async () => {
      const snapshot = structuredClone(window.__bankAuditStore);
      if (window.__bankAuditHold) {
        window.__bankAuditHold = false;
        window.__bankAuditEvents.push('old-read-started');
        return new Promise(resolve => {
          window.__bankAuditRelease = () => {
            window.__bankAuditEvents.push('old-read-resolved');
            resolve(snapshot);
          };
        });
      }
      return snapshot;
    };
    api.createEntity = async (entity, input) => {
      if (entity !== 'clients') throw new Error('Synthetic clients only');
      window.__bankAuditStore.clients.push({ ...input, id: 'audit-new-client', archivedAt: null });
      window.__bankAuditEvents.push('new-client-committed');
      return structuredClone(window.__bankAuditStore);
    };
  });
  if (options.beforeBank) await options.beforeBank(page);
  await navigate(page, 'Banque');
  if (!options.initialReadHeld) await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).waitFor();
  return page;
}

async function unmountedRefresh(browser, engine, result) {
  const page = await fixture(browser, result);
  await page.evaluate(() => { window.__bankAuditHold = true; });
  await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).click();
  await page.waitForFunction(() => typeof window.__bankAuditRelease === 'function');
  await navigate(page, 'Clients');
  await page.getByRole('button', { name: 'Nouveau client', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouveau client', exact: true });
  for (const [name, value] of Object.entries({ company: 'Client ajouté après la lecture', street: 'Rue fictive', postalCode: '1000', city: 'Lausanne' })) {
    await dialog.locator(`input[name=${name}]`).fill(value);
  }
  await dialog.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const label = page.getByText('Client ajouté après la lecture', { exact: true });
  await label.first().waitFor();
  const visibleBefore = await label.count();
  await page.screenshot({ path: join(output, `${engine}-client-before-old-read.png`) });
  await page.evaluate(() => window.__bankAuditRelease());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const visibleAfter = await label.count();
  const stored = await page.evaluate(() => window.__bankAuditStore.clients.some(client => client.id === 'audit-new-client'));
  assert.ok(visibleBefore > 0);
  assert.equal(visibleAfter > 0, !before, 'An unmounted bank read must not replace the workspace after a later save');
  assert.equal(stored, true, 'The fixture confirms UI staleness, not database deletion');
  result.cases.push({ name: 'unmounted-refresh-after-client-save', visibleBefore, visibleAfter, stored, events: await page.evaluate(() => window.__bankAuditEvents) });
  await page.screenshot({ path: join(output, `${engine}-client-after-old-read.png`) });
  await page.close();
}

async function concurrentReads(browser, result, latestFails) {
  const page = await fixture(browser, result);
  await page.evaluate(async latestFails => {
    const api = window.__qaDesktopApi;
    const originalBankRead = api.getBankWorkspace;
    const bank = await originalBankRead();
    window.__bankAuditReads = [{}, {}];
    let workspaceIndex = 0, bankIndex = 0;
    api.loadWorkspace = async () => {
      const index = workspaceIndex++;
      const snapshot = structuredClone(window.__bankAuditStore);
      if (index === 1) snapshot.clients.push({ ...snapshot.clients[0], id: 'latest-read-client', name: 'Client de la lecture récente', company: 'Client de la lecture récente' });
      return new Promise((resolve, reject) => {
        window.__bankAuditReads[index].workspace = () => index === 1 && latestFails ? reject(new Error('Lecture fictive récente indisponible.')) : resolve(snapshot);
      });
    };
    api.getBankWorkspace = async () => {
      const index = bankIndex++;
      const snapshot = structuredClone(bank);
      snapshot.accounts[0].accountId = index === 1 ? 'Compte de la lecture récente' : 'Compte de la lecture ancienne';
      return new Promise(resolve => { window.__bankAuditReads[index].bank = () => resolve(snapshot); });
    };
    // Retain the real handler to model two already-admitted reads before React
    // updates the disabled prop. No production-only API or test hook is added.
    const button = [...document.querySelectorAll('.bank-movements-panel button')].find(node => node.textContent.trim() === 'Actualiser');
    const props = button[Object.keys(button).find(key => key.startsWith('__reactProps$'))];
    props.onClick(); props.onClick();
  }, latestFails);
  await page.waitForFunction(() => window.__bankAuditReads.every(read => read.workspace && read.bank));
  await page.evaluate(() => { window.__bankAuditReads[1].workspace(); window.__bankAuditReads[1].bank(); });
  await page.getByText(/Compte de la lecture récente · CHF/).waitFor();
  if (latestFails) await page.getByText('Actualisation incomplète', { exact: true }).waitFor();
  await page.evaluate(() => { window.__bankAuditReads[0].workspace(); window.__bankAuditReads[0].bank(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const currentAccountRemains = await page.getByText(/Compte de la lecture récente · CHF/).count() > 0;
  assert.equal(currentAccountRemains, !before, 'The newer bank snapshot must survive an older response');
  const warningRemains = await page.getByText('Données à actualiser', { exact: true }).count() > 0;
  if (latestFails) assert.equal(warningRemains, !before, 'An older successful read must not clear a newer refresh warning');
  if (!latestFails) {
    await navigate(page, 'Clients');
    const latestClientRemains = await page.getByText('Client de la lecture récente', { exact: true }).count() > 0;
    assert.equal(latestClientRemains, !before, 'The older read must not replace the newer global workspace');
  }
  result.cases.push({ name: latestFails ? 'older-success-after-newer-incomplete-read' : 'older-read-after-newer-success', currentAccountRemains, warningRemains });
  await page.close();
}

async function committedImportRecovery(browser, result) {
  const page = await fixture(browser, result);
  await page.evaluate(() => {
    const api = window.__qaDesktopApi, read = api.getBankWorkspace;
    window.__bankReadCount = 0;
    api.getBankWorkspace = (...args) => { window.__bankReadCount++; return read(...args); };
  });
  await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Importer un relevé bancaire', exact: true });
  await dialog.getByRole('button', { name: 'Choisir le relevé XML', exact: true }).click();
  await dialog.getByRole('checkbox').uncheck();
  await page.evaluate(() => sessionStorage.setItem('qa-bank-fail-import-refresh', '1'));
  await dialog.getByRole('button', { name: 'Importer ce relevé', exact: true }).click();
  await dialog.getByText('Import enregistré, affichage à actualiser', { exact: true }).waitFor();
  const attempts = await page.evaluate(() => Number(sessionStorage.getItem('qa-bank-import-attempts')));
  assert.equal(attempts, 2, 'One fixture seed plus one explicit UI import');
  assert.equal(await page.locator('.bank-refresh-state').count(), 1);
  await page.evaluate(() => ['qa-bank-fail-import-refresh', 'qa-bank-workspace-refresh-fail', 'qa-bank-refresh-fail'].forEach(key => sessionStorage.removeItem(key)));
  await dialog.getByRole('button', { name: 'Actualiser les données', exact: true }).click();
  await dialog.getByRole('button', { name: 'Voir les mouvements à vérifier', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => Number(sessionStorage.getItem('qa-bank-import-attempts'))), attempts, 'Refresh must not replay the committed import');
  assert.equal(await page.locator('.bank-refresh-state').count(), 0);
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), true);
  const bankReads = await page.evaluate(() => window.__bankReadCount);
  assert.equal(bankReads, 2, 'Own workspace publications must not duplicate their bank read');
  result.cases.push({ name: 'committed-import-incomplete-read-and-read-only-recovery', attempts, bankReads, refreshOnly: true });
  await page.close();
}

async function receivedWorkspaceDuringRead(browser, result, initial) {
  const setup = async page => page.evaluate(async initial => {
    const api = window.__qaDesktopApi;
    const bank = await api.getBankWorkspace();
    window.__receivedBank = structuredClone(bank);
    window.__receivedEvents = [];
    window.__receivedBankReads = 0;
    window.__receivedHoldBank = initial;
    api.getBankWorkspace = async () => {
      window.__receivedBankReads++;
      const snapshot = structuredClone(window.__receivedBank);
      if (window.__receivedHoldBank) {
        window.__receivedHoldBank = false;
        window.__receivedEvents.push('old-bank-read-started');
        return new Promise(resolve => { window.__receivedReleaseBank = () => { window.__receivedEvents.push('old-bank-read-resolved'); resolve(snapshot); }; });
      }
      window.__receivedEvents.push('fresh-bank-read');
      if (window.__receivedHoldFresh) {
        window.__receivedHoldFresh = false;
        return new Promise(resolve => { window.__receivedReleaseFresh = () => resolve(snapshot); });
      }
      return snapshot;
    };
    window.addEventListener('zentra-company-workspace-received', () => window.__receivedEvents.push('company-workspace-received'));
  }, initial);
  const page = await fixture(browser, result, { beforeBank: setup, initialReadHeld: initial });
  if (!initial) {
    await page.evaluate(() => { window.__bankAuditHold = true; window.__receivedHoldBank = true; });
    await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.waitForFunction(() => typeof window.__bankAuditRelease === 'function');
  }
  await page.waitForFunction(() => typeof window.__receivedReleaseBank === 'function');
  if (!initial) await page.evaluate(() => { window.__receivedHoldFresh = true; window.__receivedPanel = document.querySelector('.bank-movements-panel'); });
  await page.evaluate(() => {
    const next = structuredClone(window.__bankAuditStore);
    next.settings.organization.legalName = 'Entreprise reçue plus récente';
    next.clients.push({ ...next.clients[0], id: 'received-client', name: 'Client reçu plus récent', company: 'Client reçu plus récent' });
    window.__bankAuditStore = next;
    const bank = window.__receivedBank;
    bank.movements.unshift({ ...structuredClone(bank.movements[0]), id: 'received-movement', counterpartyName: 'Mouvement bancaire reçu', reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null });
    bank.summary.movementCount++; bank.summary.unreconciledCount++;
    window.dispatchEvent(new CustomEvent('zentra-company-workspace-received', { detail: next }));
  });
  const receivedCompany = page.getByText('Entreprise reçue plus récente', { exact: true });
  await receivedCompany.first().waitFor();
  const movement = page.getByText('Mouvement bancaire reçu', { exact: true });
  let busyReleasedBeforeOld = false;
  if (!beforeReceive) {
    if (!initial) {
      await page.waitForFunction(() => typeof window.__receivedReleaseFresh === 'function');
      assert.equal(await page.evaluate(() => window.__receivedPanel === document.querySelector('.bank-movements-panel')), true, 'A background reception must keep the bank screen mounted');
      assert.equal(await page.locator('.bank-loading').count(), 0);
      assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), false, 'Fresh bank data is required before writing');
      assert.equal(await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).isEnabled(), false, 'The fresh read must not be restarted while pending');
      await page.evaluate(() => window.__receivedReleaseFresh());
    }
    await movement.waitFor();
    busyReleasedBeforeOld = await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).isEnabled();
    assert.equal(busyReleasedBeforeOld, true, 'Fresh received movements must unlock reads before the superseded read finishes');
  }
  await page.evaluate(initial => { if (!initial) window.__bankAuditRelease(); window.__receivedReleaseBank(); }, initial);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const receivedCompanyRemains = await receivedCompany.count() > 0;
  const receivedMovementRemains = await movement.count() > 0;
  const bankReads = await page.evaluate(() => window.__receivedBankReads);
  assert.equal(receivedCompanyRemains, initial || !beforeReceive, 'An old bank refresh must not replace the received global workspace');
  assert.equal(receivedMovementRemains, !beforeReceive, 'A received workspace needs a fresh bank read, including during initial loading');
  assert.equal(bankReads, (initial ? 1 : 2) + (beforeReceive ? 0 : 1), 'Reception reloads only the bank snapshot once');
  assert.equal(await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).isEnabled(), true, 'Loading and busy must both finish');
  result.cases.push({ name: initial ? 'workspace-received-during-initial-bank-read' : 'workspace-received-during-bank-refresh', receivedCompanyRemains, receivedMovementRemains, busyReleasedBeforeOld, bankReads, events: await page.evaluate(() => window.__receivedEvents) });
  await page.close();
}

async function receivedWorkspaceAfterCommittedAssociation(browser, result) {
  const page = await fixture(browser, result, { beforeBank: async page => page.evaluate(async () => {
    const api = window.__qaDesktopApi;
    window.__associationBank = structuredClone(await api.getBankWorkspace());
    window.__associationBank.accounts[0].linked = false;
    window.__associationBank.accounts[0].linkSource = 'none';
    window.__associationAttempts = 0; window.__associationReads = 0;
    api.associateBankAccount = async () => {
      window.__associationAttempts++;
      window.__associationBank.accounts[0].linked = true;
      window.__associationBank.accounts[0].linkSource = 'explicit';
    };
    api.getBankWorkspace = async () => {
      window.__associationReads++;
      const snapshot = structuredClone(window.__associationBank);
      if (window.__associationHoldBank) {
        window.__associationHoldBank = false;
        return new Promise(resolve => { window.__associationReleaseBank = () => resolve(snapshot); });
      }
      return snapshot;
    };
  }) });
  await page.locator('.bank-accounts').getByRole('button', { name: 'Associer ce compte', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Associer le compte bancaire', exact: true });
  await page.evaluate(() => { window.__bankAuditHold = true; window.__associationHoldBank = true; });
  await dialog.getByRole('button', { name: 'Associer ce compte', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => typeof window.__associationReleaseBank === 'function' && typeof window.__bankAuditRelease === 'function');
  const receiveAllowed = await page.evaluate(async () => (await import('/src/companySync.tsx')).companyReceiveAllowed());
  assert.equal(receiveAllowed, true, 'Reception is tested after the actual mutation dialog has closed');
  await page.evaluate(() => {
    const next = structuredClone(window.__bankAuditStore);
    next.settings.organization.legalName = 'Entreprise reçue après association';
    window.__bankAuditStore = next;
    const bank = window.__associationBank;
    bank.movements.unshift({ ...structuredClone(bank.movements[0]), id: 'association-received-movement', counterpartyName: 'Mouvement reçu après association', reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null });
    bank.summary.movementCount++; bank.summary.unreconciledCount++;
    window.dispatchEvent(new CustomEvent('zentra-company-workspace-received', { detail: next }));
  });
  const company = page.getByText('Entreprise reçue après association', { exact: true });
  const movement = page.getByText('Mouvement reçu après association', { exact: true });
  await company.first().waitFor();
  if (!beforeReceive) await movement.waitFor();
  assert.equal(await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).isEnabled(), false, 'A received read must not release the committed mutation lock');
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), false);
  await page.evaluate(() => { window.__bankAuditRelease(); window.__associationReleaseBank(); });
  await page.getByText('Compte associé', { exact: true }).waitFor();
  assert.equal(await company.count() > 0, !beforeReceive, 'The old post-mutation read must not replace the received workspace');
  assert.equal(await movement.count() > 0, !beforeReceive);
  assert.equal(await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).isEnabled(), true);
  const state = await page.evaluate(() => ({ attempts: window.__associationAttempts, bankReads: window.__associationReads }));
  assert.equal(state.attempts, 1, 'Reception must never replay the committed association');
  assert.equal(state.bankReads, beforeReceive ? 2 : 3);
  result.cases.push({ name: 'workspace-received-after-committed-association-during-refresh', ...state, receiveAllowed, successPreserved: true, mutationLockPreserved: true });
  await page.close();
}

async function receivedBackgroundReadFailure(browser, result) {
  if (beforeReceive) return; // The pre-fix source does not start this received bank read.
  const page = await fixture(browser, result, { beforeBank: async page => page.evaluate(async () => {
    const api = window.__qaDesktopApi;
    window.__failureBank = structuredClone(await api.getBankWorkspace());
    window.__failureReads = 0;
    api.getBankWorkspace = async () => {
      window.__failureReads++;
      const snapshot = structuredClone(window.__failureBank);
      if (window.__failureHoldOld) {
        window.__failureHoldOld = false;
        return new Promise((resolve, reject) => { window.__failureRejectOld = () => reject(new Error('Ancienne lecture fictive rejetée.')); });
      }
      if (window.__failureNextRead) { window.__failureNextRead = false; throw new Error('Lecture reçue fictive indisponible.'); }
      return snapshot;
    };
  }) });
  await page.evaluate(() => { window.__bankAuditHold = true; window.__failureHoldOld = true; });
  await page.locator('.bank-movements-panel').getByRole('button', { name: 'Actualiser', exact: true }).click();
  await page.waitForFunction(() => typeof window.__failureRejectOld === 'function' && typeof window.__bankAuditRelease === 'function');
  await page.evaluate(() => {
    const next = structuredClone(window.__bankAuditStore);
    next.settings.organization.legalName = 'Entreprise reçue avec reprise'; window.__bankAuditStore = next;
    const bank = window.__failureBank;
    bank.movements.unshift({ ...structuredClone(bank.movements[0]), id: 'failure-received-movement', counterpartyName: 'Mouvement reçu après reprise', reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null });
    bank.summary.movementCount++; bank.summary.unreconciledCount++;
    window.__failureNextRead = true;
    window.dispatchEvent(new CustomEvent('zentra-company-workspace-received', { detail: next }));
  });
  await page.locator('.bank-refresh-state').getByText('Données à actualiser', { exact: true }).waitFor();
  assert.equal(await page.locator('.bank-screen').isVisible(), true, 'A background failure keeps the existing movements visible');
  assert.equal(await page.locator('.bank-loading').count(), 0);
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), false, 'Stale movements cannot be changed after a received read fails');
  await page.locator('.bank-refresh-state').getByRole('button', { name: 'Actualiser les données', exact: true }).click();
  await page.getByText('Mouvement reçu après reprise', { exact: true }).waitFor();
  await page.getByText('Données actualisées', { exact: true }).waitFor();
  await page.evaluate(() => { window.__bankAuditRelease(); window.__failureRejectOld(); });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('Entreprise reçue avec reprise', { exact: true }).count() > 0, true);
  assert.equal(await page.getByText('Mouvement reçu après reprise', { exact: true }).count(), 1);
  assert.equal(await page.locator('.bank-refresh-state').count(), 0, 'An old failure must not reintroduce the warning after a successful retry');
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), true);
  const bankReads = await page.evaluate(() => window.__failureReads);
  assert.equal(bankReads, 4, 'Initial, superseded, received and explicit retry reads only');
  result.cases.push({ name: 'received-background-read-failure-and-retry-ignore-old-error', bankReads, screenPreserved: true, writesBlockedUntilRecovery: true });
  await page.close();
}

async function mutationRefreshAfterReceivedRead(browser, result) {
  if (beforeReceive) return;
  const page = await fixture(browser, result, { beforeBank: async page => page.evaluate(async () => {
    const api = window.__qaDesktopApi;
    const bank = structuredClone(await api.getBankWorkspace());
    bank.accounts[0].linked = true;
    const movement = { ...structuredClone(bank.movements[0]), id: 'inline-expense-movement', counterpartyName: 'Dépense synthétique en cours', creditDebit: 'DBIT', amountCents: 10810, reconciliation: null, supplierReconciliation: null, expenseReconciliation: null, refundMatch: null,
      supplierSuggestion: { kind: 'none', candidates: [], confirmable: false, reason: 'Pièce synthétique.' },
      expenseSuggestion: { reason: 'Pièce synthétique.', candidates: [{ expenseId: 'inline-expense', reference: 'DEPENSE-SYNTHETIQUE', supplier: 'Fournisseur fictif', category: 'Marchandises', date: '2026-08-31', paymentStatus: 'pending', paidAt: null, totalCents: 10810, confirmable: true, requiresDateReason: false, reason: 'Paiement synthétique.' }] } };
    bank.movements.unshift(movement); bank.summary.movementCount++; bank.summary.unreconciledCount++;
    window.__inlineBank = bank; window.__inlineReads = 0; window.__inlineAttempts = 0;
    api.getBankWorkspace = async () => {
      window.__inlineReads++;
      const snapshot = structuredClone(window.__inlineBank);
      if (window.__inlineHoldReceived) {
        window.__inlineHoldReceived = false;
        return new Promise(resolve => { window.__inlineReleaseReceived = () => resolve(snapshot); });
      }
      return snapshot;
    };
    api.confirmExpenseBankReconciliation = async () => {
      window.__inlineAttempts++;
      await new Promise(resolve => { window.__inlineCommit = resolve; });
      const row = window.__inlineBank.movements.find(row => row.id === 'inline-expense-movement');
      row.expenseReconciliation = { id: 'inline-expense-reconciliation', expenseId: 'inline-expense', journalEntryId: 'inline-journal', confirmedAt: '2026-10-02T08:00:00Z' };
      row.expenseSuggestion.candidates = [];
    };
  }) });
  const picker = page.locator('.bank-movement').filter({ has: page.getByText('Dépense synthétique en cours', { exact: true }) }).locator('.bank-expense-picker').filter({ has: page.locator('summary').filter({ hasText: 'Rapprocher une dépense' }) });
  await picker.locator('summary').click();
  await picker.locator('.bank-candidate-option').click();
  assert.equal(await picker.getByRole('radio').isChecked(), true);
  await picker.getByRole('button', { name: 'Confirmer la dépense', exact: true }).click();
  await page.waitForFunction(() => typeof window.__inlineCommit === 'function');
  const receiveAllowed = await page.evaluate(async () => (await import('/src/companySync.tsx')).companyReceiveAllowed());
  assert.equal(receiveAllowed, true, 'The inline expense operation permits reception while awaiting its synthetic mutation');
  await page.evaluate(() => {
    const next = structuredClone(window.__bankAuditStore);
    next.settings.organization.legalName = 'Entreprise reçue pendant dépense'; window.__bankAuditStore = next;
    window.__inlineHoldReceived = true;
    window.dispatchEvent(new CustomEvent('zentra-company-workspace-received', { detail: next }));
  });
  await page.waitForFunction(() => typeof window.__inlineReleaseReceived === 'function');
  assert.equal(await page.locator('.bank-screen').isVisible(), true);
  assert.equal(await page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true }).isEnabled(), false);
  await page.evaluate(() => window.__inlineCommit());
  await page.getByText('Dépense rapprochée', { exact: true }).waitFor();
  const importButton = page.locator('.bank-hero').getByRole('button', { name: 'Importer un relevé XML', exact: true });
  assert.equal(await importButton.isEnabled(), true, 'The current post-mutation refresh must release loading without awaiting the superseded received read');
  await page.evaluate(() => window.__inlineReleaseReceived());
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByText('Entreprise reçue pendant dépense', { exact: true }).count() > 0, true);
  assert.equal(await importButton.isEnabled(), true);
  const state = await page.evaluate(() => ({ attempts: window.__inlineAttempts, bankReads: window.__inlineReads }));
  assert.equal(state.attempts, 1); assert.equal(state.bankReads, 3);
  result.cases.push({ name: 'post-mutation-refresh-supersedes-pending-received-read-without-loading-deadlock', ...state, receiveAllowed, unlockedBeforeOldRead: true });
  await page.close();
}

async function run(engine) {
  const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' && process.platform === 'win32' ? { executablePath: process.env.ZENTRA_EDGE_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' } : {}) });
  const result = { engine, cases: [], errors: [], blocked: [] };
  try {
    await unmountedRefresh(browser, engine, result);
    await concurrentReads(browser, result, false);
    await concurrentReads(browser, result, true);
    await committedImportRecovery(browser, result);
    await receivedWorkspaceDuringRead(browser, result, true);
    await receivedWorkspaceDuringRead(browser, result, false);
    await receivedWorkspaceAfterCommittedAssociation(browser, result);
    await receivedBackgroundReadFailure(browser, result);
    await mutationRefreshAfterReceivedRead(browser, result);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.blocked, []);
    result.passed = true;
  } catch (error) { result.passed = false; result.failure = error.stack; }
  finally { await browser.close(); }
  return result;
}

const results = await Promise.all(['chromium', 'webkit'].map(run));
await writeFile(join(output, 'report.json'), JSON.stringify({ origin, before, beforeReceive, results }, null, 2));
console.log(JSON.stringify({ output, results }, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
