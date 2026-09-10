import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const out = '.qa/client-readiness-20260908/timer-recovery-ui';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
const report = [];
try {
  for (const width of [320, 390, 861, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5192'}/tests/mobile-harness.html?browsing=1&design=1&timerRecovery=1`);
    await page.getByRole('button', { name: 'Découvrir plus tard', exact: true }).click();
    await page.getByRole('button', { name: 'Aller à un écran', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Rechercher un écran' }).fill('Temps');
    await page.locator('.navigation-palette__results button').filter({ has: page.getByText('Temps', { exact: true }) }).click();
    const panel = page.getByRole('region', { name: 'Pointages conservés', exact: true });
    const preserve = panel.getByRole('button', { name: 'Conserver le pointage en attente', exact: true });
    await preserve.waitFor();
    await page.evaluate(() => window.__qaSetReadOnly(true));
    assert.equal(await preserve.isDisabled(), true);
    await page.evaluate(() => window.__qaSetReadOnly(false));
    await preserve.click();
    assert.equal(await page.evaluate(async () => (await import('/src/businessWorkspaceLock.ts')).businessActivityPending()), true);
    await page.evaluate(() => window.__qaChangeTimer());
    await panel.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await panel.getByText('Le chronomètre a changé.', { exact: false }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Arrêter et conserver', exact: true }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__qaTimerCalls), []);
    await panel.getByRole('button', { name: 'Annuler', exact: true }).click();
    await preserve.click();
    await panel.getByRole('button', { name: 'Arrêter et conserver', exact: true }).click();
    await panel.getByText('Terminez la résolution avant d’affecter ces heures.', { exact: true }).waitFor();
    assert.equal(await panel.getByRole('button', { name: 'Affecter à un projet', exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__qaTimerCalls.filter(c => c.action === 'preserve').length), 1);
    await page.evaluate(() => window.__qaFinishTimerResolution());
    await panel.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await panel.getByRole('button', { name: 'Affecter à un projet', exact: true }).click();
    const project = panel.getByLabel('Projet du pointage', { exact: false });
    assert.equal(await project.inputValue(), '');
    assert.equal(await panel.getByLabel('Collaborateur du pointage', { exact: true }).inputValue(), 'employee-previous', 'An existing historical employee remains selected even when inactive');
    const save = panel.getByRole('button', { name: 'Enregistrer les heures', exact: true });
    assert.equal(await save.isDisabled(), true);
    await project.selectOption('project-other');
    await page.evaluate(() => sessionStorage.setItem('timer-state-error', '1'));
    await panel.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await panel.getByText('Lecture des pointages indisponible.', { exact: true }).waitFor();
    assert.equal(await save.isDisabled(), true);
    await page.evaluate(() => sessionStorage.removeItem('timer-state-error'));
    await panel.getByRole('button', { name: 'Actualiser', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.timer-recovery [role=alert]'));
    assert.equal(await project.inputValue(), 'project-other', 'Selection survives a failed refresh');
    await page.evaluate(() => sessionStorage.setItem('timer-assignment-error', '1'));
    await save.click();
    await panel.getByText('Affectation indisponible. Le pointage est conservé.', { exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.equal(await panel.getByText('Affectation indisponible. Le pointage est conservé.', { exact: true }).isVisible(), true, 'Readback must not erase the action error');
    assert.equal(await project.inputValue(), 'project-other');
    const layout = await panel.evaluate(element => ({
      overflow: document.documentElement.scrollWidth - innerWidth,
      clipped: [...element.querySelectorAll('button,select,.field')].filter(el => el.getClientRects().length && el.scrollWidth > el.clientWidth + 2).map(el => el.outerHTML.slice(0, 140)),
    }));
    assert.ok(layout.overflow <= 1);
    assert.deepEqual(layout.clipped, []);
    await panel.screenshot({ path: `${out}/${width}-assignment.png` });
    await page.evaluate(() => { sessionStorage.removeItem('timer-assignment-error'); sessionStorage.setItem('timer-refresh-error', '1'); });
    await save.click();
    await panel.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__qaTimerCalls.filter(c => c.action === 'assign').length), 2, 'One failed write and one successful write; refresh failure does not write again');
    assert.equal(await page.evaluate(async () => (await import('/src/businessWorkspaceLock.ts')).businessActivityPending()), false);
    assert.deepEqual(errors, []);
    report.push({ width, staleTimerRejected: true, readOnly: true, retryAndReadback: true, layout });
    await page.close();
  }
} finally { await browser.close(); await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report));
