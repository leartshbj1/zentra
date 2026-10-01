import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium, webkit } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.ZENTRA_QA_ORIGIN || 'http://127.0.0.1:5363';
const output = process.env.ZENTRA_MOTION_QA_OUTPUT || '.qa/navigation-motion';
const report = [];
await mkdir(output, { recursive: true });
for (const [engine, browserType] of [['edge', chromium], ['webkit', webkit]]) {
  const browser = await browserType.launch({ headless: true, ...(engine === 'edge' ? { channel: 'msedge' } : {}) });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    page.setDefaultTimeout(8000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('elyko-guided-tour-v3', 'completed'));
    const touch = async (selector, type, x, y) => {
      await page.locator(selector).first().evaluate((element, { type, x, y }) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        const points = type === 'touchend' || type === 'touchcancel' ? [] : [{ identifier: 0, clientX: x, clientY: y }];
        Object.defineProperty(event, 'touches', { value: points }); element.dispatchEvent(event);
      }, { type, x, y });
      await page.evaluate(() => new Promise(requestAnimationFrame));
    };
    const offset = () => page.locator('#primary-navigation').evaluate(element => new DOMMatrix(getComputedStyle(element).transform).m41);
    const settled = async open => {
      await page.waitForFunction(open => {
        const element = document.getElementById('primary-navigation');
        return element && !element.dataset.dragging && !element.dataset.settling && Math.abs(new DOMMatrix(getComputedStyle(element).transform).m41 - (open ? 0 : -element.offsetWidth)) < .5;
      }, open);
    };
    try {
      await page.goto(`${origin}/tests/mobile-harness.html?browsing=1&design=1`);
      await page.locator('.desktop-app').waitFor(); await settled(false);
      const width = await page.locator('#primary-navigation').evaluate(element => element.offsetWidth);
      await touch('.app-main', 'touchstart', 5, 220);
      await touch('.app-main', 'touchmove', 45, 220);
      assert.ok(Math.abs(await offset() - (-width + 40)) < .5, 'Drawer follows the finger from its actual closed edge');
      await touch('.app-main', 'touchmove', 85, 220);
      assert.ok(Math.abs(await offset() - (-width + 80)) < .5, 'Next movement remains 1:1');
      await touch('.app-main', 'touchcancel'); await settled(false);
      await page.locator('.menu-button').focus(); await page.locator('.menu-button').click(); await settled(true);
      assert.ok(await page.locator('#primary-navigation').evaluate(element => element.contains(document.activeElement)), 'Menu keeps keyboard focus');
      // Reorder an equally sized active item without changing the React selection prop.
      await page.locator('.sidebar__nav').evaluate(nav => {
        const active = nav.querySelector('[aria-current="page"]'); active.parentElement.append(active);
      });
      await page.waitForFunction(() => {
        const nav = document.querySelector('.sidebar__nav'), active = nav.querySelector('[aria-current="page"]');
        return Math.abs(parseFloat(nav.style.getPropertyValue('--selection-y')) - (active.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop)) < .5;
      });
      // An aria-only selection update must also be observed, including aria-current=false.
      await page.locator('.sidebar__nav').evaluate(nav => {
        nav.querySelector('[aria-current="page"]').setAttribute('aria-current', 'false');
        nav.querySelector('button:not([aria-current])').setAttribute('aria-current', 'page');
      });
      await page.waitForFunction(() => {
        const nav = document.querySelector('.sidebar__nav'), active = nav.querySelector('[aria-current="page"]');
        return Math.abs(parseFloat(nav.style.getPropertyValue('--selection-y')) - (active.getBoundingClientRect().top - nav.getBoundingClientRect().top + nav.scrollTop)) < .5;
      });
      await page.keyboard.press('Escape'); await settled(false);
      const triggerFocusRestored = await page.locator('.menu-button').evaluate(element => document.activeElement === element);
      assert.equal(triggerFocusRestored, true, 'Escape restores the trigger focus');
      assert.equal(await page.locator('#primary-navigation').evaluate(element => element.contains(document.activeElement)), false, 'Closed/inert navigation never retains focus');
      // Grab the visible closing panel, even though React has already committed closed/inert.
      await page.locator('.menu-button').click(); await settled(true);
      await page.locator('.navigation-scrim').click({ position: { x: 380, y: 220 } });
      const grabHandle = await page.waitForFunction(() => {
        const element = document.getElementById('primary-navigation'), x = new DOMMatrix(getComputedStyle(element).transform).m41;
        if (element.dataset.settling !== 'true' || x >= -35 || x <= -element.offsetWidth + 90) return false;
        // Dispatch in the observed frame; a separate locator call could arrive after it closes.
        const grabX = Math.min(40, element.getBoundingClientRect().right - 10);
        const event = new Event('touchstart', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: [{ identifier: 0, clientX: grabX, clientY: 220 }] });
        document.querySelector('.app-main').dispatchEvent(event);
        return { grabbed: new DOMMatrix(getComputedStyle(element).transform).m41, grabX };
      });
      const { grabbed, grabX } = await grabHandle.jsonValue();
      await page.waitForTimeout(35);
      assert.ok(Math.abs(await offset() - grabbed) < .5, 'Grabbing freezes the presented value');
      await touch('.app-main', 'touchmove', grabX + 16, 220);
      assert.ok(Math.abs(await offset() - Math.min(0, grabbed + 16)) < .5, 'An interrupted panel follows the new grab offset without a jump');
      await touch('.app-main', 'touchmove', grabX + 100, 220);
      await touch('.app-main', 'touchend'); await settled(true);
      // A slow initial closing movement followed by a recent opening flick must reopen.
      await touch('#primary-navigation', 'touchstart', 250, 220);
      for (const x of [210, 170, 130, 90, 50, 20]) { await page.waitForTimeout(100); await touch('#primary-navigation', 'touchmove', x, 220); }
      await touch('#primary-navigation', 'touchmove', 45, 220);
      await touch('#primary-navigation', 'touchmove', 65, 220);
      await touch('#primary-navigation', 'touchend'); await settled(true);
      await page.keyboard.press('Escape'); await settled(false);
      if (engine === 'edge') {
        await page.mouse.move(5, 220); await page.mouse.down(); await page.mouse.move(85, 220, { steps: 4 });
        assert.ok(Math.abs(await offset() - (-width + 80)) < .5, 'Mouse Pointer Events follow the same 1:1 path');
        await page.mouse.move(290, 220, { steps: 4 }); await page.mouse.up(); await settled(true);
        await page.keyboard.press('Escape'); await settled(false);
      }
      await page.locator('.menu-button').click(); await settled(true);
      await page.locator('.sidebar__close').click();
      await page.waitForFunction(() => document.getElementById('primary-navigation').dataset.settling === 'true');
      await page.emulateMedia({ reducedMotion: 'reduce' }); await settled(false);
      await touch('.app-main', 'touchstart', 5, 220);
      await touch('.app-main', 'touchmove', 290, 220); await touch('.app-main', 'touchend'); await settled(true);
      assert.equal(await page.locator('#primary-navigation').getAttribute('data-settling'), null, 'Reduced motion leaves no settling animation');
      await page.keyboard.press('Escape'); await settled(false);
      assert.deepEqual(errors, []);
      report.push({ engine, tracking: true, cancel: true, interruption: true, recentReversal: true, selectionRebinding: true, focusContainedAndReleased: true, triggerFocusRestored, reducedMotion: true, mouse: engine === 'edge', errors });
    } catch (error) {
      await page.screenshot({ path: `${output}/failure-${engine}.png` });
      report.push({ engine, error: String(error), errors }); throw error;
    } finally { await page.close(); }
  } finally { await browser.close(); await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2)); }
}
console.log(JSON.stringify(report));
