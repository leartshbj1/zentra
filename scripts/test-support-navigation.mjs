import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright',
);
const base = process.env.SUPPORT_PREVIEW_URL || 'http://127.0.0.1:5393';
if (
  new URL(base).protocol !== 'http:' ||
  !['localhost', '127.0.0.1'].includes(new URL(base).hostname)
)
  throw new Error('Local public-page preview only.');
const output =
  process.env.ZENTRA_UX_EVIDENCE_DIR ||
  'D:/Codex-Zentra-Temporary/2026-10-06/ux/support-navigation';
await mkdir(output, { recursive: true });
const source = fileURLToPath(new URL('..', import.meta.url));
const sourceFiles = [
  'components/support/marketing-shell.tsx',
  'components/support/product-navigation.tsx',
  'app/user-clarity.css',
  'scripts/test-support-navigation.mjs',
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourceFiles.map(async (name) => [
        name,
        createHash('sha256')
          .update(await readFile(path.join(source, name)))
          .digest('hex'),
      ]),
    ),
  );
const expectedControls = {
  fr: [
    'Afficher les rubriques précédentes',
    'Afficher les rubriques suivantes',
  ],
  de: ['Vorherige Bereiche anzeigen', 'Weitere Bereiche anzeigen'],
  it: ['Mostra le sezioni precedenti', 'Mostra le sezioni successive'],
  en: ['Show previous sections', 'Show more sections'],
};
const expectedPaths = [
  '/support',
  '/support/fonctionnalites',
  '/support/connexions',
  '/support/solutions',
  '/support/securite',
  '/support/tarifs',
];
const sourceLabels = [
  'Présentation',
  'Fonctionnalités',
  'Connexions',
  'Cas d’usage',
  'Sécurité',
  'Tarifs',
];
const proof = {
  startedAt: new Date().toISOString(),
  base,
  sourceBefore: await hashes(),
  engine: 'Microsoft Edge (Chromium)',
  input:
    'emulated viewport, synthesized CDP touch, native scroll buttons and keyboard',
  physicalDevice: false,
  safari: false,
  cases: [],
  errors: [],
};
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
const metrics = (page) =>
  page.locator('.sp-product-sections').evaluate((frame) => {
    const nav = frame.querySelector('nav'),
      controls = [...frame.querySelectorAll('button')];
    return {
      overflow: frame.dataset.overflow,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      scrollLeft: nav.scrollLeft,
      maximum: nav.scrollWidth - nav.clientWidth,
      links: [...nav.querySelectorAll('a')].map((link) => ({
        href: link.getAttribute('href'),
        current: link.getAttribute('aria-current'),
        label: link.textContent.trim(),
      })),
      controls: controls.map((button) => ({
        label: button.getAttribute('aria-label'),
        disabled: button.disabled,
        width: button.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
        display: getComputedStyle(button).display,
        ownsNav: button.getAttribute('aria-controls') === nav.id,
      })),
    };
  });
try {
  for (const language of ['fr', 'de', 'it', 'en']) {
    const dictionary =
      language === 'fr'
        ? {}
        : JSON.parse(
            await readFile(
              path.join(source, `lib/site-copy/${language}.json`),
              'utf8',
            ),
          );
    for (const width of [320, 390, 1440]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        hasTouch: width < 700,
        isMobile: width < 700,
        reducedMotion: 'reduce',
        deviceScaleFactor: 1,
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return ['localhost', '127.0.0.1'].includes(url.hostname) ||
          ['data:', 'blob:'].includes(url.protocol)
          ? route.continue()
          : route.abort();
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const response = await page.goto(`${base}/support?lang=${language}`, {
        waitUntil: 'networkidle',
        timeout: 60000,
      });
      assert.equal(response.status(), 200);
      await page.evaluate(() => document.fonts.ready);
      await settle(page);
      const initial = await metrics(page);
      assert.deepEqual(
        initial.links.map((link) => link.href),
        expectedPaths,
      );
      assert.deepEqual(
        initial.links.map((link) => link.label),
        sourceLabels.map((label) => dictionary[label] || label),
      );
      assert.equal(initial.links[0].current, 'page');
      assert.deepEqual(
        initial.controls.map((control) => control.label),
        expectedControls[language],
      );
      assert.equal(
        initial.controls.every((control) => control.ownsNav),
        true,
      );
      assert.equal(initial.pageOverflow, false);
      if (width < 700) {
        assert.equal(initial.overflow, 'true');
        assert.equal(
          initial.controls.every(
            (control) => control.width >= 44 && control.height >= 44,
          ),
          true,
        );
        assert.equal(initial.controls[0].disabled, true);
        assert.equal(initial.controls[1].disabled, false);
      } else {
        assert.equal(initial.overflow, 'false');
        assert.equal(
          initial.controls.every((control) => control.display === 'none'),
          true,
        );
      }
      await page
        .locator('.sp-product-navigation')
        .screenshot({
          path: path.join(output, `${language}-${width}-initial.png`),
        });
      const entry = {
        language,
        width,
        status: response.status(),
        initial,
        errors,
      };
      if (width < 700) {
        const nav = page.locator('.sp-product-sections nav');
        const next = page.getByRole('button', {
          name: expectedControls[language][1],
          exact: true,
        });
        const previous = page.getByRole('button', {
          name: expectedControls[language][0],
          exact: true,
        });
        for (let click = 0; click < 8 && !(await next.isDisabled()); click++) {
          await next.click();
          await settle(page);
        }
        entry.end = await metrics(page);
        assert.equal(entry.end.controls[1].disabled, true);
        assert.ok(Math.abs(entry.end.scrollLeft - entry.end.maximum) <= 1);
        await previous.focus();
        await page.keyboard.press('Enter');
        await settle(page);
        entry.keyboardButton = await metrics(page);
        assert.ok(entry.keyboardButton.scrollLeft < entry.end.scrollLeft);
        assert.equal(
          await previous.evaluate(
            (button) => document.activeElement === button,
          ),
          true,
        );
        await nav.evaluate((element) => {
          element.scrollLeft = 0;
          element.querySelector('a').focus();
        });
        for (let tab = 0; tab < 5; tab++) await page.keyboard.press('Tab');
        await settle(page);
        entry.keyboardLink = {
          ...(await metrics(page)),
          focused: await page.evaluate(() =>
            document.activeElement?.getAttribute('href'),
          ),
        };
        assert.equal(entry.keyboardLink.focused, '/support/tarifs');
        assert.ok(entry.keyboardLink.scrollLeft > 10);
        await nav.evaluate((element) => {
          element.scrollLeft = 0;
        });
        await settle(page);
        const rectangle = await nav.boundingBox(),
          session = await context.newCDPSession(page);
        const start = rectangle.x + rectangle.width * 0.8,
          end = rectangle.x + rectangle.width * 0.2;
        const y = rectangle.y + rectangle.height * 0.5;
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchStart',
          touchPoints: [{ x: start, y }],
        });
        for (let step = 1; step <= 8; step++) {
          await session.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: start + ((end - start) * step) / 8, y }],
          });
          await page.waitForTimeout(20);
        }
        await session.send('Input.dispatchTouchEvent', {
          type: 'touchEnd',
          touchPoints: [],
        });
        await page.waitForTimeout(200);
        await session.detach();
        entry.touch = await metrics(page);
        assert.ok(entry.touch.scrollLeft > 10);
        await page.setViewportSize({ width: 1440, height: 900 });
        await settle(page);
        entry.expanded = await metrics(page);
        assert.equal(entry.expanded.overflow, 'false');
        assert.equal(entry.expanded.pageOverflow, false);
        await page.setViewportSize({ width: 320, height: 900 });
        await settle(page);
        entry.narrowed = await metrics(page);
        assert.equal(entry.narrowed.overflow, 'true');
        assert.equal(entry.narrowed.pageOverflow, false);
      } else {
        await page.locator('.sp-product-sections nav a').evaluateAll((links) =>
          links.forEach((link) => {
            link.style.fontSize = '32px';
          }),
        );
        await settle(page);
        entry.largeText = await metrics(page);
        assert.equal(entry.largeText.overflow, 'true');
        assert.equal(entry.largeText.pageOverflow, false);
        await page.locator('.sp-product-sections nav a').evaluateAll((links) =>
          links.forEach((link) => {
            link.style.fontSize = '';
          }),
        );
        await settle(page);
        entry.restoredText = await metrics(page);
        assert.equal(entry.restoredText.overflow, 'false');
      }
      assert.deepEqual(errors, []);
      proof.cases.push(entry);
      await context.close();
    }
  }
  proof.completedAt = new Date().toISOString();
  proof.sourceAfter = await hashes();
  assert.deepEqual(proof.sourceAfter, proof.sourceBefore);
  proof.passed = true;
} catch (error) {
  proof.errors.push(error instanceof Error ? error.message : String(error));
  proof.passed = false;
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(
    path.join(output, 'results.json'),
    JSON.stringify(proof, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: proof.passed,
      cases: proof.cases.length,
      errors: proof.errors,
      output,
    }),
  );
}
