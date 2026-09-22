import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.SUPPORT_PREVIEW_URL || 'http://127.0.0.1:5298';
if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
  throw Error('Local preview only');
const output = new URL('../.qa/support-design/', import.meta.url);
await mkdir(output, { recursive: true });
const compiled = ts.transpileModule(
  await readFile(
    new URL('../components/support/model.ts', import.meta.url),
    'utf8',
  ),
  { compilerOptions: { module: ts.ModuleKind.ESNext } },
).outputText;
const { demoState } = await import(
  'data:text/javascript;base64,' + Buffer.from(compiled).toString('base64')
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const report = [];
try {
  for (const width of [1440, 820, 390, 320]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      reducedMotion: 'reduce',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/support/demo', { waitUntil: 'networkidle' });
    await page
      .getByRole('heading', { name: 'Tous les tickets', exact: true })
      .waitFor();
    await page.screenshot({
      path: new URL('final-' + width + '.png', output).pathname.replace(
        /^\/([A-Z]:)/,
        '$1',
      ),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const folder = async (name) => {
      if (width <= 760)
        await page
          .getByRole('button', { name: 'Dossiers', exact: true })
          .click();
      await page
        .getByRole('navigation', { name: 'Dossiers des tickets' })
        .getByRole('button', { name, exact: true })
        .click();
    };
    await folder('Remboursement');
    await page
      .getByRole('heading', { name: 'Remboursement', exact: true })
      .waitFor();
    assert.equal(await page.locator('.support-ticket-row').count(), 1);
    await page.getByLabel('Filtrer par état').selectOption('review');
    await page
      .getByRole('heading', { name: 'Aucun ticket dans cette vue.' })
      .waitFor();
    await page
      .getByRole('button', { name: 'Tout afficher', exact: true })
      .click();
    await page.getByRole('searchbox').fill('payer');
    await page.waitForFunction(
      () => document.querySelectorAll('.support-ticket-row').length === 1,
    );
    assert.match(
      await page.locator('.support-ticket-row').textContent(),
      /Impossible de payer/,
    );
    await page.getByRole('searchbox').fill('');
    await page.waitForFunction(
      () => document.querySelectorAll('.support-ticket-row').length === 4,
    );
    const first = page.locator('.support-ticket-row').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.tagName === 'H2');
    assert.equal(
      await page.locator('.support-review-disclosure').getAttribute('open'),
      null,
    );
    await page.getByText('Modifier le classement', { exact: true }).click();
    await page
      .getByRole('heading', { name: 'Corriger l’affectation' })
      .waitFor();
    if (width <= 1100) {
      await page.screenshot({
        path: new URL('detail-' + width + '.png', output).pathname.replace(
          /^\/([A-Z]:)/,
          '$1',
        ),
        fullPage: true,
      });
      await page.getByRole('button', { name: 'Retour à la liste' }).click();
      await page.waitForFunction(() =>
        document.activeElement?.classList.contains('support-ticket-row'),
      );
    }
    await folder('À vérifier');
    await page.locator('.support-ticket-row').click();
    await page
      .getByRole('button', { name: 'Appliquer dans mon outil', exact: true })
      .click();
    await page.getByRole('status').waitFor();
    assert.match(await page.getByRole('status').textContent(), /simulée/);
    for (const name of [
      'Routage',
      'Connexions',
      'Résultats',
      'Équipe',
      'Abonnement',
    ]) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        name + ' overflow at ' + width,
      );
    }
    await page.getByRole('tab', { name: 'Tickets' }).click();
    if (width <= 760) {
      await page.getByRole('button', { name: 'Dossiers', exact: true }).click();
      await page.getByText('Autres dossiers', { exact: true }).click();
      await page.screenshot({
        path: new URL('folders-' + width + '.png', output).pathname.replace(
          /^\/([A-Z]:)/,
          '$1',
        ),
        fullPage: true,
      });
    }
    assert.deepEqual(errors, []);
    report.push({
      width,
      folders: true,
      search: true,
      combinedFilters: true,
      keyboard: true,
      review: true,
      allSections: true,
      noOverflow: true,
    });
    await page.close();
  }
  // Exercise the actual non-demo component with a local, intercepted API only.
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const state = demoState();
  const requests = [];
  await page.route(/\/api\/support(?:\?|$)/, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    requests.push({ method: req.method(), query: url.search });
    if (req.method() === 'POST') {
      const body = req.postDataJSON();
      assert.equal(body.action, 'importTicket');
      state.tickets.unshift({
        ...state.tickets[0],
        id: 'imported',
        externalId: '9999',
        subject: 'Ticket importé hors du dossier',
        decision: { ...state.tickets[0].decision, category: 'bug' },
      });
      return route.fulfill({ json: { ticketId: 'imported' } });
    }
    const tickets = state.tickets.filter(
      (t) =>
        (!url.searchParams.get('category') ||
          t.decision.category === url.searchParams.get('category')) &&
        (!url.searchParams.get('state') ||
          t.state === url.searchParams.get('state')),
    );
    return route.fulfill({ json: { ...state, tickets } });
  });
  await page.goto(base + '/support/espace', { waitUntil: 'networkidle' });
  await page
    .getByRole('heading', { name: 'Tous les tickets', exact: true })
    .waitFor();
  await page
    .getByRole('navigation', { name: 'Dossiers des tickets' })
    .getByRole('button', { name: 'Remboursement', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.support-ticket-list')
        ?.getAttribute('aria-busy') === 'false',
  );
  await page
    .getByRole('button', { name: 'Importer un ticket', exact: true })
    .click();
  await page.getByLabel('Numéro du ticket dans votre outil').fill('9999');
  await page
    .getByRole('button', { name: 'Importer et analyser', exact: true })
    .click();
  await page
    .getByRole('heading', {
      name: 'Ticket importé hors du dossier',
      exact: true,
    })
    .waitFor();
  assert(requests.some((r) => r.query.includes('category=refund')));
  assert.equal(
    await page.getByRole('heading', { level: 1 }).textContent(),
    'Tous les tickets',
  );
  report.push({
    importFromCategory: true,
    unfilteredReload: true,
    externalWrites: 0,
  });
  await page.close();
} finally {
  await browser.close();
}
await writeFile(
  new URL('results.json', output),
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report, null, 2));
