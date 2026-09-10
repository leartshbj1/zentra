export async function expandAccountingPeriodFilters(page) {
  await page.getByLabel('Date de début de la période', { exact: true }).waitFor({ state: 'attached' });
  const toggle = page.locator('.accounting-period-toggle');
  if (await toggle.isVisible() && await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
}
