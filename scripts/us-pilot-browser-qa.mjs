import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
const base = process.env.US_QA_BASE_URL || 'http://localhost:4318';
const out = '.qa/us';
const capture = process.env.US_QA_SKIP_CAPTURES !== '1';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const findings = [];
const events = [];
const errors = [];
const submissions = [];
async function ready(
  page,
  path = '/us?utm_source=qa-us&utm_medium=email&utm_campaign=pilot',
) {
  await page.goto(`${base}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await page.evaluate(() => document.fonts.ready);
}
async function setup(viewport, reducedMotion = 'reduce') {
  const page = await browser.newPage({ viewport, reducedMotion });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/us-pilot/events', async (route) => {
    events.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: '{"ok":true}',
    });
  });
  return page;
}
async function overflow(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.us-page *')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return (
          r.width &&
          (r.right > innerWidth + 2 || r.left < -2) &&
          style.position !== 'fixed' &&
          !el.classList.contains('site-skip-link')
        );
      })
      .map((el) => ({
        tag: el.tagName,
        class: el.className,
        text: el.textContent.slice(0, 45),
      }))
      .slice(0, 15),
  );
}
try {
  for (const [name, width, height] of [
    ['desktop', 1440, 1000],
    ['mobile', 390, 844],
    ['small-mobile', 320, 740],
    ['tablet', 820, 1180],
  ]) {
    const page = await setup({ width, height });
    await ready(page);
    assert.match(await page.title(), /AI-Powered Business Operations/);
    assert.equal(await page.locator('h1').count(), 1);
    assert.equal(
      await page
        .getByText('Coming soon to the United States.', { exact: true })
        .count(),
      1,
    );
    assert.equal(
      await page.locator('.us-offer-note').innerText(),
      '1 month free. No credit card. No commitment.',
    );
    assert.equal(await page.locator('.us-management-features h3').count(), 6);
    assert.match(
      await page.locator('#us-management').innerText(),
      /Estimates & invoicing/,
    );
    assert.equal(
      await page.locator('link[rel=canonical]').getAttribute('href'),
      'https://zentraapp.ch/us',
    );
    assert.equal(
      await page.locator('meta[property="og:locale"]').getAttribute('content'),
      'en_US',
    );
    assert.equal(
      await page.locator('.us-demo-hero .us-result-ready').count(),
      1,
    );
    assert.equal(
      await page.getByRole('button', { name: 'Pause demo' }).count(),
      0,
    );
    const spills = await overflow(page);
    assert.deepEqual(spills, [], `${name} horizontal overflow`);
    if (capture)
      await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
    if (capture && ['desktop', 'mobile'].includes(name))
      await page.screenshot({ path: `${out}/${name}-hero.png` });
    if (capture && name === 'desktop')
      await page
        .locator('#us-management')
        .screenshot({ path: `${out}/${name}-management.png` });
    if (capture && name === 'mobile') {
      await page.evaluate(() =>
        document
          .getElementById('us-management')
          .scrollIntoView({ block: 'start', behavior: 'instant' }),
      );
      await page.screenshot({ path: `${out}/${name}-management.png` });
    }
    findings.push({
      viewport: name,
      width,
      height,
      overflow: spills.length,
      reducedMotion: 'static completed workflows',
    });
    if (name === 'mobile') {
      await page
        .getByRole('button', { name: 'Join the US Pilot' })
        .first()
        .click();
      await page.getByRole('dialog').waitFor();
      assert.match(
        await page.locator('.us-form-offer').innerText(),
        /US pilot access is activated/,
      );
      if (capture) await page.screenshot({ path: `${out}/mobile-form.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden' });
    }
    await page.close();
  }
  const page = await setup({ width: 1440, height: 1000 });
  await ready(page);
  const availabilityQuestion = page
    .locator('summary')
    .filter({ hasText: 'Is Zentra available in the US today?' });
  await availabilityQuestion.click();
  assert.match(
    await page.locator('details[open]').innerText(),
    /US version is coming/,
  );
  await availabilityQuestion.click();
  await page.getByRole('button', { name: 'Watch Zentra in Action' }).click();
  assert.equal(await page.locator('.us-demo-hero .us-result-ready').count(), 1);
  for (const [label, expected] of [
    ['Customer request', 'Scope change'],
    ['Meeting', 'America/New_York'],
    ['Vendor invoice', '$2,840.00'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    assert.ok(
      (await page.locator('#us-workflows .us-record').innerText()).includes(
        expected,
      ),
    );
  }
  // Every conversion CTA opens the same accessible application form.
  for (const button of await page
    .getByRole('button', { name: 'Join the US Pilot', exact: true })
    .all()) {
    await button.click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  await page
    .locator('#us-pilot')
    .getByRole('button', { name: 'Apply for Early Access', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await dialog
    .getByRole('button', { name: 'Apply for Early Access', exact: true })
    .click();
  assert.match(
    await dialog.getByRole('alert').innerText(),
    /highlighted fields/,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    'us-first_name',
  );
  await dialog.getByLabel('First name', { exact: true }).fill('Alex');
  await dialog.getByLabel('Last name', { exact: true }).fill('Taylor');
  await dialog.getByLabel('Work email', { exact: true }).fill('invalid');
  await dialog
    .getByLabel('Company', { exact: true })
    .fill('QA Fixture Company');
  await dialog
    .getByLabel('Company website', { exact: false })
    .fill('example.com');
  await dialog.getByLabel('Industry', { exact: true }).fill('Consulting');
  await dialog
    .getByLabel('Number of employees', { exact: true })
    .selectOption('11–30');
  await dialog
    .getByLabel(
      'What’s the most repetitive administrative task in your business?',
      { exact: true },
    )
    .fill('Copying information between emails and project tools.');
  await dialog
    .getByLabel('What tools do you currently use to run your business?', {
      exact: true,
    })
    .fill('Email and a spreadsheet.');
  await dialog.getByRole('radio', { name: 'Yes', exact: true }).check();
  await dialog
    .getByRole('button', { name: 'Apply for Early Access', exact: true })
    .click();
  assert.match(
    await dialog.locator('#us-error-email').innerText(),
    /valid work email/,
  );
  await dialog
    .getByLabel('Work email', { exact: true })
    .fill('fixture@example.test');
  let saveStatus = 503;
  await page.route('**/api/us-pilot/leads', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      status: saveStatus,
      contentType: 'application/json',
      body: JSON.stringify(
        saveStatus === 201
          ? { ok: true }
          : {
              error:
                'We could not save this right now. Please try again shortly.',
            },
      ),
    });
  });
  await dialog
    .getByRole('button', { name: 'Apply for Early Access', exact: true })
    .click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'could not save' })
    .waitFor();
  assert.equal(
    await dialog.getByLabel('Work email', { exact: true }).inputValue(),
    'fixture@example.test',
  );
  await page.screenshot({ path: `${out}/desktop-form-error.png` });
  saveStatus = 201;
  await dialog
    .getByRole('button', { name: 'Apply for Early Access', exact: true })
    .click();
  await dialog.getByRole('heading', { name: 'You’re on our list.' }).waitFor();
  assert.match(await dialog.innerText(), /1 month free/);
  assert.match(
    await dialog.innerText(),
    /does not start your free month or create a subscription/,
  );
  assert.equal(
    submissions.at(-1).submission_id,
    submissions.at(-2).submission_id,
  );
  assert.equal(submissions.at(-1).utm_campaign, 'pilot');
  assert.equal(submissions.at(-1).demo_interest, true);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
    window.scrollTo(0, 0);
  });
  assert.deepEqual(await overflow(page), [], '200% text overflow');
  await page.close();
  const motion = await setup({ width: 1440, height: 1000 }, 'no-preference');
  await ready(motion);
  await motion.getByRole('button', { name: 'Watch Zentra in Action' }).click();
  const currentStage = motion.locator('.us-demo-hero .us-record-heading');
  await currentStage
    .filter({ hasText: 'Understanding the message' })
    .waitFor({ timeout: 5000 });
  await motion.getByRole('button', { name: 'Pause demo' }).click();
  const pausedStage = await currentStage.innerText();
  await motion.waitForTimeout(400);
  assert.equal(await currentStage.innerText(), pausedStage);
  await motion.getByRole('button', { name: 'Resume demo' }).click();
  assert.equal(
    await currentStage.innerText(),
    pausedStage,
    'Resume must retain the paused stage',
  );
  await motion
    .locator('.us-demo-hero .us-result-ready')
    .waitFor({ timeout: 20000 });
  await motion
    .getByRole('button', { name: 'Replay demo' })
    .first()
    .waitFor({ timeout: 5000 });
  await motion.close();
  for (const name of [
    'page_view',
    'watch_demo',
    'demo_completed',
    'pilot_cta_clicked',
    'pilot_form_started',
  ])
    assert.ok(
      events.some((e) => e.event_name === name),
      `Missing ${name}`,
    );
  assert.ok(
    events.some(
      (e) =>
        e.event_name === 'demo_completed' && e.properties.mode === 'manual',
    ),
  );
  assert.ok(
    !events.some((e) => e.event_name === 'pilot_form_submitted'),
    'Conversion must be server-owned',
  );
  assert.deepEqual(errors, [], 'Browser runtime errors');
  await writeFile(
    `${out}/browser-results.json`,
    JSON.stringify(
      {
        findings,
        events: events.map((e) => ({
          name: e.event_name,
          properties: e.properties,
        })),
        submissions: submissions.length,
        errors,
        formTransport:
          'stubbed success and failure; server and real RLS verified separately',
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      viewports: findings.length,
      events: [...new Set(events.map((e) => e.event_name))],
      form: 'validation, error persistence, retry identity, success, CTAs, Escape',
      animation: 'pause/replay/manual completion/reduced motion',
      textZoom: '200%',
      errors,
    }),
  );
} finally {
  await browser.close();
}
