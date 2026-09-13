import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { nogaLabel, nogaLabels } from './nogaLanguage';
import { PAYROLL_ORGANISATION_HELP } from './swissPayrollDirectory';
import { translations } from './translations';

it('covers every section and division in the native NOGA 2025 catalogue', () => {
  const native=readFileSync(new URL('../src-tauri/src/noga.rs',import.meta.url),'utf8');
  const codes=[...native.matchAll(/Section \{ code: "([A-V])"/g),...native.matchAll(/\("(\d{2})", "/g)].map(match=>match[1]);
  expect(codes.filter(code=>code.length===1)).toHaveLength(22);
  expect(codes.length).toBeGreaterThan(100);
  expect(Object.keys(nogaLabels).sort()).toEqual(codes.sort());
  for (const code of codes) for (const language of ['de','it','en'] as const) expect(nogaLabel(code,'Français',language),code).not.toBe('Français');
  expect(nogaLabel('A','Texte du catalogue','fr')).toBe('Texte du catalogue');
  expect(nogaLabel('future-code','Libellé futur','de')).toBe('Libellé futur');
});

it('localises every insurance directory label, hint and scope without replacing organisation names', () => {
  for(const entry of Object.values(PAYROLL_ORGANISATION_HELP)) for(const field of ['label','hint','scope'] as const) expect(translations[entry[field]],entry[field]).toHaveLength(3);
});
