import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SUPPORT_PREVIEW_URL || 'http://localhost:5348';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw Error('Local only');
const dir = '.impeccable/review/support-productivity';
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true }),
  report = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({
        viewport: { width, height: 960 },
        reducedMotion: 'reduce',
      }),
      errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    async function capture(name) {
      await page.evaluate(() => {
        window.scrollTo(0, 0);
        document.querySelector('.support-sidebar')?.scrollTo(0, 0);
        document.querySelectorAll('textarea').forEach((t) => (t.scrollTop = 0));
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${name} overflow ${width}`,
      );
      await page.screenshot({
        path: `${dir}/${name}-${width}.png`,
        fullPage: true,
      });
    }
    await page.goto(base + '/support/demo', { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { name: 'Tous les tickets', exact: true })
      .waitFor();
    await capture('daily');
    if (width <= 760)
      await page.getByRole('button', { name: 'Dossiers', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Dossiers des tickets' })
      .getByRole('button', { name: 'Démarchage', exact: true })
      .click();
    await page.locator('.support-batch > summary').click();
    await page
      .getByRole('checkbox', { name: 'Sélectionner les 3 premiers' })
      .check();
    await page
      .getByRole('button', { name: 'Préparer les réponses STOP' })
      .click();
    await page
      .getByText(
        'Même destinataire : une seule réponse sera préparée dans ce lot.',
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page.locator('.support-batch-reply textarea').count(),
      2,
    );
    const send = page.getByRole('button', {
      name: 'Envoyer les 2 réponses vérifiées',
    });
    assert.equal(await send.isDisabled(), true);
    for (const c of await page
      .getByRole('checkbox', {
        name: 'J’ai vérifié ce destinataire et ce texte',
      })
      .all())
      await c.check();
    assert.equal(await send.isDisabled(), false);
    const body = page.locator('.support-batch-reply textarea').first();
    await body.fill((await body.inputValue()) + '\nMerci.');
    assert.equal(await send.isDisabled(), true);
    await page
      .getByRole('checkbox', {
        name: 'J’ai vérifié ce destinataire et ce texte',
      })
      .first()
      .check();
    await capture('batch');
    if (process.env.CAPTURE_BATCH_ONLY === '1') {
      report.push({
        width,
        errors,
        overflow: false,
        actions: 'batch field recapture',
      });
      await page.close();
      continue;
    }
    await send.click();
    await page
      .getByText(
        'Traitement terminé. Consultez le résultat de chaque réponse.',
        { exact: true },
      )
      .waitFor();
    await page
      .locator('.support-ticket-row')
      .filter({ hasText: 'Une idée pour la visibilité de votre atelier' })
      .click();
    await page
      .getByRole('button', { name: 'Créer un suivi', exact: true })
      .click();
    await page
      .getByRole('textbox', { name: 'À faire', exact: true })
      .fill('Comparer cette proposition avec Léa');
    await page.locator('input[type="datetime-local"]').fill('2026-10-01T10:30');
    await capture('followup');
    await page
      .getByRole('button', { name: 'Enregistrer le suivi', exact: true })
      .click();
    await page
      .locator('.support-followup-saved')
      .getByText('Comparer cette proposition avec Léa', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Protéger cet expéditeur' }).click();
    await page
      .getByRole('heading', { name: 'Vos préférences de classement' })
      .waitFor();
    assert.equal(
      await page
        .getByRole('textbox', { name: 'Adresse de l’expéditeur' })
        .inputValue(),
      'alex@horizon.example',
    );
    await page.getByRole('button', { name: 'Ajouter la préférence' }).click();
    await page
      .locator('.support-rule-row')
      .getByText('alex@horizon.example', { exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Désactiver', exact: true }).click();
    await page
      .locator('.support-rule-row')
      .getByText('Expéditeur fiable · désactivée', { exact: true })
      .waitFor();
    await capture('rules');
    await page.getByRole('tab', { name: 'Connexions', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Réception des messages' })
      .waitFor();
    await capture('health');
    assert.deepEqual(errors, []);
    report.push({
      width,
      errors,
      overflow: false,
      actions:
        'deduplicated batch review/edit/confirm; followup; trusted sender; rule toggle; health',
    });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(
    `${dir}/${process.env.CAPTURE_BATCH_ONLY === '1' ? 'batch-recapture' : 'report'}.json`,
    JSON.stringify(report, null, 2),
  );
}
console.log(JSON.stringify(report));
