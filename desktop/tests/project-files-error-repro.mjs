import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = createRequire(import.meta.url)(process.env.ZENTRA_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'msedge' } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto('http://127.0.0.1:5192/tests/project-files-harness.html');
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Notes du projet') });
  await page.getByRole('button', { name: 'Enregistrer 1 fichier', exact: true }).click();
  await page.locator('.project-document-list__open').click();
  await page.getByRole('button', { name: 'Ouvrir avec une application', exact: true }).click();
  await page.getByRole('alert').waitFor();
  const result = { errorInDialog: await page.getByRole('dialog').getByRole('alert').count(), errorBehindDialog: await page.locator('.project-folder > .error-panel').count() };
  await mkdir('.qa/project-files', { recursive: true });
  const stage = result.errorInDialog ? 'after' : 'before';
  await writeFile(`.qa/project-files/${stage}-error.json`, JSON.stringify(result, null, 2));
  await page.screenshot({ path: `.qa/project-files/${stage}-error.png` });
  console.log(JSON.stringify(result));
} finally { await browser.close(); }
