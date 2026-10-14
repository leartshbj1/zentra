import { expect, it } from 'vitest';
import { createAutopilotBudget } from './autopilotBudget';
import { readFileSync } from 'node:fs';

const page = (confirmed = 0, held = 0, reviewRequired = 0) => ({ status: 'progress', phase: 'page', counts: { confirmed, held, reviewRequired } });
it('keeps the reserved HTTP cost aligned with the native twenty-source page and recovery bound', () => {
  const source = readFileSync(new URL('../src-tauri/src/account_cloud_action_engine.rs', import.meta.url), 'utf8');
  expect(source).toMatch(/const WORK_PAGE_SIZE:\s*u32\s*=\s*20;/);
  expect(source).toContain('WORK_PAGE_SIZE as usize');
  expect(source).toContain('limit: WORK_PAGE_SIZE');
});
it('keeps one hour of idle discovery below the real work quota with room for refresh', () => {
  let now = 0; const budget = createAutopilotBudget(() => now);
  for (let count = 0; count < 240; count++) {
    now = count * 15_000;
    const charge = budget.reserve('company-a', 'tick'); expect(charge).not.toBeNull(); charge!.settleTick(page());
  }
  for (let count = 0; count < 20; count++) {
    const charge = budget.reserve('company-a', 'tick'); expect(charge).not.toBeNull(); charge!.settleTick(page());
  }
});
it('reserves the worst real native page cost before invoking it: 21 work and 40 execution requests', () => {
  const budget = createAutopilotBudget(() => 1);
  let work = 0, execution = 0;
  for (let count = 0; count < 10; count++) {
    const charge = budget.reserve('company-a', 'tick'); expect(charge).not.toBeNull();
    work += 21; execution += 40; charge!.settleTick(page(20));
  }
  expect(work).toBe(210); expect(execution).toBe(400);
  expect(budget.reserve('company-a', 'tick')).toBeNull();
});
it('retains uncertain charges and recovery execution costs instead of assuming zero HTTP', () => {
  const budget = createAutopilotBudget(() => 1);
  for (let count = 0; count < 5; count++) expect(budget.reserve('company-a', 'tick')).not.toBeNull();
  for (let count = 0; count < 5; count++) {
    const charge = budget.reserve('company-a', 'tick'); expect(charge).not.toBeNull();
    charge!.settleTick({ status: 'progress', phase: 'recovery', counts: { confirmed: 0, held: 0, reviewRequired: 0 } });
  }
  expect(budget.reserve('company-a', 'tick')).toBeNull();
});
it('does not expire an in-flight tick or release its unknown cost after a late failure', () => {
  let now = 0; const budget = createAutopilotBudget(() => now), charges = [];
  for (let count = 0; count < 10; count++) charges.push(budget.reserve('company-a', 'tick')!);
  now = 3_600_001; expect(budget.reserve('company-a', 'tick')).toBeNull();
  charges.forEach(charge => charge.finish());
  now += 3_599_999; expect(budget.reserve('company-a', 'tick')).toBeNull();
  now++; expect(budget.reserve('company-a', 'tick')).not.toBeNull();
});
it('never refunds twice or accepts counts outside the native page bound', () => {
  const budget = createAutopilotBudget(() => 1);
  const first = budget.reserve('company-a', 'tick')!; first.settleTick(page(20)); first.settleTick(page());
  for (let count = 0; count < 9; count++) budget.reserve('company-a', 'tick')!.settleTick(page(21));
  expect(budget.reserve('company-a', 'tick')).toBeNull();
});
it.each([['consent',50],['activity',100],['review',100]] as const)('leaves server headroom for %s', (kind, maximum) => {
  let now = 1; const budget = createAutopilotBudget(() => now);
  for (let count = 0; count < maximum; count++) expect(budget.reserve('company-a', kind)).not.toBeNull();
  expect(budget.reserve('company-a', kind)).toBeNull();
  expect(budget.reserve('company-b', kind)).not.toBeNull();
  now += 3_600_000; expect(budget.reserve('company-a', kind)).not.toBeNull();
});
it('keeps a server 429 paused through refresh/reconnection until the next UTC window plus margin', () => {
  let now = 1_800_000; const budget = createAutopilotBudget(() => now);
  budget.rateLimited('company-a');
  for (let count = 0; count < 100; count++) expect(budget.reserve('company-a', 'tick')).toBeNull();
  now = 3_604_999; expect(budget.reserve('company-a', 'consent')).toBeNull();
  now++; expect(budget.reserve('company-a', 'tick')).not.toBeNull();
});
