import { it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { runtimeVolumeFixture } from '../tests/runtime-volume-fixture';
const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ Channel: class {}, invoke }));
import { desktopApi } from './bridge';
import { salesTotalsByCurrency } from './salesFinancials';
import { formatMoney, formatDate, formatDateTime } from './utils';

it('measures actual bridge decoding and financial rendering on a synthetic company', async () => {
  const count = Number(process.env.ZENTRA_PERF_COUNT || 1500);
  const raw = runtimeVolumeFixture(count);
  invoke.mockImplementation(async command => {
    if (command === 'get_app_state') return { onboarding_completed: true, activity_profile_required: false, data_dir: '', app_version: 'performance-test' };
    if (command === 'get_workspace') return raw;
    throw Error(`Unexpected command: ${command}`);
  });
  const runs: any[] = [];
  for (let run = 0; run < 3; run++) {
    let start = performance.now();
    const workspace = await desktopApi.loadWorkspace();
    const normalizeMs = performance.now() - start;
    expect(workspace.invoices).toHaveLength(count);
    expect(workspace.invoices[0].lines).toHaveLength(8);
    start = performance.now();
    const financials = salesTotalsByCurrency(workspace.invoices, workspace.payments);
    const totalsMs = performance.now() - start;
    start = performance.now();
    const labels = workspace.invoices.map(row => `${formatMoney(86480,row.currency)} ${formatDate(row.issueDate)} ${formatDateTime(row.createdAt)}`);
    const formattingMs = performance.now() - start;
    runs.push({ normalizeMs, totalsMs, formattingMs, resultSha256: createHash('sha256').update(JSON.stringify({workspace,financials,labels})).digest('hex') });
  }
  expect(new Set(runs.map(run => run.resultSha256)).size).toBe(1);
  const result = { countPerDocumentType: count, documentTypes: 9, linesPerDocument: 8, runs };
  if (process.env.ZENTRA_PERF_OUTPUT) { mkdirSync('.qa/runtime-speed', { recursive: true }); writeFileSync(process.env.ZENTRA_PERF_OUTPUT, JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result));
}, 60_000);
