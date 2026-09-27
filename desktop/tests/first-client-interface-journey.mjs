import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const pw = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5357';
const output = '.qa/first-client-interface';
await mkdir(output, { recursive: true });
const proof = [];
const onlySettings = process.argv.includes('--settings-only');
const labels = {
  fr: ['Messagerie', 'Devis', 'Factures', 'Vérifier et enregistrer', 'Enregistrer les modèles', 'Envoyer l’e-mail', 'Variable inconnue'],
  de: ['E-Mail', 'Offerten', 'Rechnungen', 'Prüfen und speichern', 'Vorlagen speichern', 'E-Mail senden', 'Unbekannte Variable'],
  it: ['Posta', 'Preventivi', 'Fatture', 'Verifica e salva', 'Salva i modelli', 'Invia l’e-mail', 'Variabile sconosciuta'],
  en: ['Mailbox', 'Quotes', 'Invoices', 'Verify and save', 'Save templates', 'Send email', 'Unknown variable'],
};
for (const engine of ['chromium', 'webkit']) {
  const browser = await pw[engine].launch({ headless: true, ...(engine === 'chromium' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of (onlySettings ? [] : [320, 390, 1440])) for (const language of ['fr', 'de', 'it', 'en']) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
      await page.addInitScript(language => localStorage.setItem('zentra.interface.language.v1', language), language);
      const theme = width === 1440 ? 'light' : 'dark';
      await page.goto(`${origin}/tests/outgoing-mail-preview.html?connected=1&logo=1&theme=${theme}`);
      await page.getByRole('button', { name: labels[language][3], exact: true }).waitFor();
      assert.equal(await page.locator('.mail-tabs button').count(), 3);
      const tabs = await page.locator('.mail-tabs button').evaluateAll(nodes => nodes.map(node => {
        const box = node.getBoundingClientRect();
        return { text: node.textContent, height: box.height, clipped: node.scrollWidth > node.clientWidth + 1 };
      }));
      assert.deepEqual(tabs.map(tab => tab.text), labels[language].slice(0, 3));
      assert.ok(tabs.every(tab => tab.height >= 44 && !tab.clipped), JSON.stringify(tabs));
      await page.screenshot({ path: `${output}/mail-${engine}-${width}-${language}.png`, fullPage: true });
      await page.getByRole('button', { name: labels[language][1], exact: true }).click();
      const subject = page.locator('.mail-fields--single input');
      assert.equal(await subject.inputValue(), 'Votre devis {numero} — {entreprise}', 'Customer template is not translated');
      await subject.fill('Document {not_a_variable}');
      await page.getByRole('button', { name: labels[language][4], exact: true }).click();
      await page.getByText(labels[language][6], { exact: false }).waitFor();
      assert.equal(await page.evaluate(() => window.__mailQa.templates), 0);
      assert.equal(await subject.inputValue(), 'Document {not_a_variable}');
      await page.screenshot({ path: `${output}/mail-error-${engine}-${width}-${language}.png`, fullPage: true });
      await page.getByRole('button', { name: 'Préparer un e-mail', exact: true }).click();
      await page.getByRole('button', { name: labels[language][5], exact: true }).waitFor();
      assert.equal(await page.locator('.mail-composer input[maxlength="250"]').inputValue(), 'Votre facture F-2026-0142 — Atelier du Léman');
      assert.ok((await page.locator('.mail-from').innerText()).includes('<contact@example.invalid>'));
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: `${output}/composer-${engine}-${width}-${language}.png` });
      assert.deepEqual(errors, []);
      proof.push({ engine, width, language, theme, localized: true, variablesPreserved: true, draftPreserved: true, touchTargets: true, overflow: false });
      await page.close();
    }
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => route.request().url().startsWith(origin) || route.request().url().startsWith('data:') ? route.continue() : route.abort());
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&companyRealtime=1&assistant=1`);
      await page.getByRole('button', { name: 'Fermer le guide automatique', exact: true }).click();
      await page.waitForFunction(() => window.companyRealtimeFixture?.calls.some(call => call.command === 'sync_company_workspace'));
      const launcher = page.locator('.assistant-launcher--docked');
      await launcher.waitFor();
      assert.equal(await page.locator('body > .assistant-launcher').count(), 0);
      assert.equal(await launcher.evaluate(node => getComputedStyle(node).position), 'static');
      await launcher.click();
      await page.getByRole('dialog', { name: 'Assistant Zentra', exact: true }).waitFor();
      await page.getByRole('dialog', { name: 'Assistant Zentra', exact: true }).getByRole('button', {name:/^Fermer « Assistant Zentra/}).click();
      await page.getByRole('dialog', { name: 'Assistant Zentra', exact: true }).waitFor({state:'hidden'});
      async function navigate(name) {
        if (width < 1101) await page.getByRole('button', { name: 'Tous les modules', exact: true }).click();
        await page.locator('.sidebar').getByRole('button', { name, exact: true }).click();
      }
      await navigate('Paramètres');
      await page.locator('[data-settings-link="company"]').click();
      const name = page.locator('input[name="legalName"]');
      await name.waitFor({ state: 'visible' });
      await page.evaluate(() => window.companyRealtimeFixture.renameCompany('Entreprise reçue automatiquement'));
      await page.waitForFunction(() => document.querySelector('input[name="legalName"]')?.value === 'Entreprise reçue automatiquement', null, { timeout: 6500 });
      assert.equal(await page.locator('[data-settings-id="company"]').getAttribute('open'), '');
      await name.fill('Brouillon à conserver');
      await name.blur();
      // Save an independent category while the first form remains unsaved.
      if (width < 1101) await page.getByRole('button', { name: 'Tous les paramètres', exact: true }).click();
      await page.locator('[data-settings-link="time"]').click();
      await page.locator('input[name="workWeekHours"]').fill('42');
      await page.getByRole('button', { name: 'Enregistrer les règles', exact: true }).click();
      await page.waitForFunction(async () => (await window.__qaDesktopApi.loadWorkspace()).settings.work.workWeekHours === 42);
      const applied = await page.evaluate(() => window.companyRealtimeFixture.calls.filter(call => call.command === 'apply_company_update').length);
      await page.evaluate(() => window.companyRealtimeFixture.renameCompany('Entreprise version suivante'));
      await page.waitForTimeout(3500);
      assert.equal(await name.inputValue(), 'Brouillon à conserver');
      await page.getByRole('button', { name: /Nouveautés en attente\. Enregistrez vos modifications, puis quittez les paramètres/ }).waitFor();
      assert.equal(await page.evaluate(() => window.companyRealtimeFixture.calls.filter(call => call.command === 'apply_company_update').length), applied);
      // A hidden category retains its unsaved draft and still prevents replacement.
      if (width < 1101) await page.getByRole('button', { name: 'Tous les paramètres', exact: true }).click();
      await page.locator('[data-settings-link="appearance"]').click();
      await page.waitForTimeout(3200);
      assert.equal(await page.evaluate(() => window.companyRealtimeFixture.calls.filter(call => call.command === 'apply_company_update').length), applied);
      const waitingDetail = await page.locator('.company-sync-indicator').getAttribute('title');
      assert.equal(waitingDetail, 'Enregistrez vos modifications, puis quittez les paramètres pour recevoir les nouveautés de votre équipe.');
      await page.locator('.company-sync-indicator').click();
      await page.getByText('État de la synchronisation', { exact: true }).click();
      await page.getByText(waitingDetail, { exact: true }).waitFor({state:'visible'});
      await page.getByText(waitingDetail, { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${output}/settings-${engine}-${width}.png` });
      await navigate('Tableau de bord');
      await page.waitForFunction(() => document.querySelector('.topbar__company')?.textContent === 'Entreprise version suivante', null, { timeout: 5500 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      proof.push({ engine, width, pristineSettingsReceive: true, latestFormValues: true, categoryPreserved: true, visibleAndHiddenDraftsProtected: true, draftProtectedAfterPartialSave: true, waitingDetail, receiveAfterLeaving: true, assistantDocked: true, assistantOpens: true });
      await page.close();
    }
  } finally { await browser.close(); }
}
const proofPath = `${output}/${onlySettings ? 'settings-review-proof' : 'proof'}.json`;
await writeFile(proofPath, JSON.stringify(proof, null, 2));
console.log(JSON.stringify({ passed: proof.length, proof: proofPath }));
