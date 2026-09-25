import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5331';
const results = [];
for (const [engine, type] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true, ...(engine === 'edge' && process.platform === 'win32' ? { channel: 'msedge' } : {}) });
  try {
    for (const width of [390, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      for (const actions of [['client', 'project', 'quote', 'invoice'], ['purchase', 'employee', 'agenda', 'clients']]) {
        await page.addInitScript(actions => {
          localStorage.setItem('elyko-guided-tour-v3', 'completed');
          localStorage.setItem('zentra.workspace.preferences.v1', JSON.stringify({ version: 1, shortcuts: ['dashboard', 'projects', 'quotes', 'agenda'], actions }));
        }, actions);
        await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&readOnly=1`);
        const buttons = page.locator('[data-personalized-actions] button');
        await buttons.first().waitFor();
        assert.equal(await buttons.count(), 4);
        for (let index = 0; index < 4; index++) assert.equal(await buttons.nth(index).isDisabled(), !['agenda', 'clients'].includes(actions[index]), `Read-only ${actions[index]}`);
        if (actions.includes('agenda')) {
          await buttons.nth(2).click();
          assert.equal(await page.locator('.desktop-app').getAttribute('data-view'), 'agenda');
        }
      }
      await page.addInitScript(() => localStorage.setItem('zentra.workspace.preferences.v1', JSON.stringify({ version: 1, shortcuts: ['dashboard', 'projects', 'quotes', 'agenda'], actions: ['project', 'client', 'quote', 'purchase'] })));
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1&workflowHelp=1`);
      await page.locator('[data-personalized-actions] button').first().click();
      assert.equal(await page.locator('.desktop-app').getAttribute('data-view'), 'projects');
      await page.locator('#creation-help-projects').waitFor({ state: 'visible' });
      assert.match(await page.locator('#creation-help-projects').innerText(), /client/i);
      await page.locator('.creation-action__help button').click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      assert.match(await page.getByRole('dialog').innerText(), /client/i);
      assert.deepEqual(errors, []);
      results.push({ engine, width, sixWriteActionsDisabled: true, readActionAvailable: true, prerequisiteExplainedAndActionable: true });
      await page.close();
    }
  } finally { await browser.close(); }
}
await mkdir('.qa/personalization', { recursive: true });
await writeFile('.qa/personalization/permissions-results.json', JSON.stringify(results, null, 2));
console.log(JSON.stringify(results));
