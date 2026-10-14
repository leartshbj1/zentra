import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const ps=readFileSync(new URL('./quote-autopilot-verification.ps1',import.meta.url),'utf8');
const entry=readFileSync(new URL('./verify-action-live-profile-windows.ps1',import.meta.url),'utf8');
const rust=readFileSync(new URL('../src-tauri/src/account_cloud_quote_autopilot_tests.rs',import.meta.url),'utf8');
test('nine actual Rust test names are selected exactly once',()=>{
  const names=[...rust.matchAll(/#\[test\]\s*fn\s+(\w+)\s*\(/g)].map(m=>m[1]);assert.equal(names.length,9);
  for(const name of names) assert.equal(ps.split("'"+name+"'").length-1,1);
  assert.match(ps,/account_cloud::action_engine::supervisor::tests::/);assert.match(ps,/--exact/);
});
test('import defines functions, entrypoint runs only after original profile proof',()=>{
  assert.equal(ps.trimStart().startsWith('# Function definitions only.'),true);
  assert.ok(entry.indexOf('Assert-ZentraLiveProfileAdmission -Context $admission')<entry.indexOf("quote-autopilot-verification.ps1"));
  assert.ok(entry.indexOf('$harness.Proof.suiteExecutions.Count -ne 11')<entry.indexOf('Invoke-ZentraAutopilotProductVerification'));
  assert.match(entry,/suiteExecutions \| Select-Object -First 11/);
});
test('separate receipt cannot claim release or complete business journey',()=>{
  assert.match(ps,/opensProduct=\$false/);assert.match(ps,/businessJourneyExecuted=\$false/);assert.match(ps,/releasePublished=\$false/);
  assert.match(ps,/runtimePassed -ne 9/);assert.match(ps,/suiteExecutions.Count -ne 20/);
  assert.match(ps,/finally\s*\{/);assert.match(ps,/autopilot-product-native-proof.json/);
  assert.ok(!/Bearer|OAI-Sites-Authorization|ZENTRA_A41_BROWSER_COOKIE_QA|quote-work|fetch\(/.test(ps));
});
