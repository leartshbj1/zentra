// Reproducible, code-native social artwork. Reuses the existing Zentra wordmark.
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE ||
    'C:/Users/alb/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright',
);
await mkdir('public/us', { recursive: true });
const logo = (await readFile('public/brand/zentra-wordmark.png')).toString(
  'base64',
);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<html lang="en"><head><style>*{box-sizing:border-box}body{margin:0;background:#f8faf7;color:#173d2c;font-family:Arial,sans-serif;padding:60px;display:flex;flex-direction:column;height:630px}img{width:150px;height:auto}h1{font-size:72px;line-height:1.06;letter-spacing:-2px;font-weight:600;margin:48px 0 24px;max-width:1000px}h1 span{color:#627661}p{font-size:25px;line-height:1.5;margin:0}.terms{font-size:19px;margin-top:14px;color:#59675f}.foot{margin-top:auto;display:flex;align-items:center;justify-content:space-between;border-top:1px solid #dce3dd;padding-top:22px;font-size:18px}.tag{background:#173d2c;color:white;border-radius:7px;padding:12px 20px}</style></head><body><img alt="Zentra" src="data:image/png;base64,${logo}"/><h1>Zentra is coming<br/><span>to the United States.</span></h1><p>Customer management. Projects. Invoicing. Planned AI workflows.</p><p class="terms">1 month free when US access starts. No credit card. No commitment.</p><div class="foot"><span>Built for small business. Ready for your input.</span><span class="tag">Join the US Pilot</span></div></body></html>`,
  );
  await page.locator('img').evaluate((image) => image.decode());
  await page.screenshot({ path: 'public/us/og.png' });
  console.log('public/us/og.png · 1200 × 630');
} finally {
  await browser.close();
}
