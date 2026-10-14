// Pure bridge execution and native source contracts; no HTTP/native subprocess.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const bridge = readFileSync(new URL('../src/bridge.ts', import.meta.url), 'utf8');
const native = readFileSync(new URL('../src-tauri/src/account_cloud_quote_autopilot.rs', import.meta.url), 'utf8');
const consumer = readFileSync(new URL('../src-tauri/src/account_cloud_action_engine.rs', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
const methods = ['getQuoteAutopilotState','readQuoteAutopilotConsent','setQuoteAutopilotConsent','tickQuoteAutopilot','readQuoteAutopilotActivity','readQuoteAutopilotReview'];
const ast = ts.createSourceFile('bridge.ts', bridge, ts.ScriptTarget.Latest, true);
const object = ast.statements.flatMap(s => ts.isVariableStatement(s) ? s.declarationList.declarations : [])
  .find(d => d.name.getText(ast) === 'desktopApi').initializer;
const members = object.properties.filter(p => methods.includes(p.name?.getText(ast)));
assert.equal(members.length, 6);
const block = bridge.slice(bridge.indexOf('export type QuoteAutopilotOrigin'), bridge.indexOf("import { diagnosticInvoke"));
const source = `${block}\nexport const api={${members.map(m => m.getText(ast)).join(',')}};`;
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
let transport = () => { throw new Error('UNEXPECTED_INVOKE'); };
const exports = {};
new Function('exports', 'invoke', output.outputText)(exports, (...args) => transport(...args));
const origin = () => ({ expectedWorkspaceScope:'workspace', expectedMemberContextNonce:'a'.repeat(32) });
const envelope = (status='available', fields={}) => ({schemaVersion:1,status,code:status==='available'?'none':'product_gate_closed',organizationId:status==='available'?'org':null,workspaceScope:status==='available'?'workspace':null,memberContextNonce:status==='available'?'a'.repeat(32):null,...fields});
const consent = () => ({schemaVersion:1,enabled:false,revision:0,consentVersion:null,requiredConsentVersion:'action-engine-quote-draft-customer-2026-10-11'});
const review = () => ({proposalId:'proposal',sourceId:'source',createdAt:1,disposition:'needs_review',reasons:['low_confidence'],requiresHumanValidation:true});
const activity = () => ({activityId:'activity',proposalId:'proposal',quoteId:'11111111-1111-4111-8111-111111111111',confirmedAt:1,kind:'quote_draft_created',requiresHumanValidation:true});
const refused = fn => assert.throws(fn, /^Error: AUTOPILOT_INVALID_NATIVE_CONTRACT$/);

test('all six fixed IPC commands capture only their closed arguments', async () => {
  const names=['quote_autopilot_state','quote_autopilot_consent','set_quote_autopilot_consent','quote_autopilot_tick','quote_autopilot_activity','quote_autopilot_review'];
  for (const [index,name] of methods.entries()) {
    transport=async (command,args) => { assert.equal(command,names[index]); assert.deepEqual(Object.keys(args).sort(),[0,1,3].includes(index)?['origin']:['input','origin']); assert.deepEqual(args.origin,origin());
      if (index===0) return envelope('unavailable',{canManage:false});
      if (index===3) return envelope('unavailable',{phase:'none',counts:null,roundComplete:false,hasMore:false,pendingRecovery:false});
      return envelope('unavailable',{data:null}); };
    const input=index===2?{schemaVersion:1,enabled:false,consentVersion:null,expectedRevision:1}:{limit:20,cursor:null};
    assert.equal((await exports.api[name](origin(),input)).status,'unavailable');
  }
});
test('origin is copied before await and cannot be replaced by a late company', async () => {
  let resolve; transport=()=>new Promise(yes=>{resolve=yes;}); const input=origin();
  const pending=exports.api.getQuoteAutopilotState(input); input.expectedWorkspaceScope='other';
  resolve(envelope('available',{canManage:true})); assert.equal((await pending).workspaceScope,'workspace');
});
test('cross-context replies and raw extra data are refused', () => {
  for (const mutate of [v=>v.workspaceScope='other',v=>v.memberContextNonce='b'.repeat(32),v=>v.token='secret',v=>v.code='unknown']) {
    const value=envelope('available',{canManage:false}); mutate(value); refused(()=>exports.quoteAutopilotStateFromRaw(value,origin()));
  }
});
test('input authority injection, getters, unknown keys and nonces refuse without invoke', async () => {
  for (const input of [{...origin(),organizationId:'other'},{...origin(),expectedMemberContextNonce:'A'.repeat(32)},{...origin(),expectedWorkspaceScope:''}])
    await assert.rejects(exports.api.tickQuoteAutopilot(input), /AUTOPILOT_INVALID_NATIVE_CONTRACT/);
  let read=false; const input={expectedWorkspaceScope:'workspace',get expectedMemberContextNonce(){read=true;return 'a'.repeat(32);}};
  refused(()=>exports.captureQuoteAutopilotOrigin(input)); assert.equal(read,false);
});
test('consent CAS is explicit and version/revision/false rules are closed', () => {
  const valid={schemaVersion:1,enabled:true,consentVersion:consent().requiredConsentVersion,expectedRevision:0};
  assert.ok(Object.isFrozen(exports.captureQuoteAutopilotConsentInput(valid)));
  for (const bad of [{...valid,expectedRevision:2147483648},{...valid,consentVersion:'automation'},{...valid,enabled:false},{...valid,actor:'owner'}])
    refused(()=>exports.captureQuoteAutopilotConsentInput(bad));
  assert.equal(exports.quoteAutopilotReadFromRaw(envelope('available',{data:consent()}),origin(),'consent').data.enabled,false);
});
test('canonical activity keeps exact IDs and bounds; duplicate rows never become notifications', () => {
  const page={organizationId:'org',items:[activity()],nextCursor:null};
  const parse=value=>exports.quoteAutopilotReadFromRaw(envelope('available',{data:value}),origin(),'activity',20);
  assert.deepEqual(parse(page).data,page);
  for (const bad of [{...page,organizationId:'other'},{...page,items:[activity(),{...activity(),proposalId:'other'}]},{...page,items:[{...activity(),quoteId:'not-uuid'}]},{...page,items:[{...activity(),amount:100}]}]) refused(()=>parse(bad));
});
test('review is read-only bounded reasons, with no plan or confidence', () => {
  const page={organizationId:'org',items:[review()],nextCursor:null};
  const parse=value=>exports.quoteAutopilotReadFromRaw(envelope('available',{data:value}),origin(),'review',1);
  assert.ok(Object.isFrozen(parse(page).data.items[0].reasons));
  for (const bad of [{...page,items:[{...review(),confidence:0.58}]},{...page,items:[{...review(),reasons:['override']}]},{...page,items:[{...review(),reasons:['low_confidence','low_confidence']}]},{...page,nextCursor:'x'.repeat(4097)},{...page,items:[review(),review()]}]) refused(()=>parse(bad));
});
test('arrays refuse holes, custom properties and accessors without reading them', () => {
  for (const items of [Array(1),Object.assign([review()],{extra:true})])
    refused(()=>exports.quoteAutopilotReadFromRaw(envelope('available',{data:{organizationId:'org',items,nextCursor:null}}),origin(),'review',20));
  let read=false;const items=[];Object.defineProperty(items,'0',{enumerable:true,get(){read=true;return review();}});
  refused(()=>exports.quoteAutopilotReadFromRaw(envelope('available',{data:{organizationId:'org',items,nextCursor:null}}),origin(),'review',20));assert.equal(read,false);
});
test('review counters remain separate from activity and gated responses clear every datum', () => {
  const value=envelope('available',{status:'needs_review',phase:'page',counts:{confirmed:0,held:0,reviewRequired:1},roundComplete:true,hasMore:false,pendingRecovery:false});
  assert.equal(exports.quoteAutopilotTickFromRaw(value,origin()).status,'needs_review');
  refused(()=>exports.quoteAutopilotTickFromRaw({...value,counts:{confirmed:0,held:0,reviewRequired:0}},origin()));
  refused(()=>exports.quoteAutopilotReadFromRaw(envelope('unavailable',{data:consent()}),origin(),'consent'));
});
test('native compile gate, exact registration and detached physical lock remain explicit', () => {
  assert.match(native,/const PRODUCT_ENABLED: bool = false;/);
  assert.match(native,/if !PRODUCT_ENABLED \{ return Err\("product_gate_closed"\); \}/);
  for (const command of ['quote_autopilot_state','quote_autopilot_consent','set_quote_autopilot_consent','quote_autopilot_tick','quote_autopilot_activity','quote_autopilot_review'])
    assert.ok(lib.includes(`account_cloud::action_engine::supervisor::${command},`));
  assert.match(native,/let Some\(mut flight\) = supervisor\.round\.try_lock_owned\(\)/);
  const tick=native.slice(native.indexOf('pub(crate) async fn quote_autopilot_tick'));
  assert.equal((tick.match(/advance_quote_work_round\(/g)||[]).length,1);
  assert.ok(tick.indexOf('tauri::async_runtime::spawn')<tick.indexOf('advance_quote_work_round('));
  assert.ok(tick.indexOf('current(&worker, &captured, &stamp).await',tick.indexOf('advance_quote_work_round('))>0);
  assert.doesNotMatch(native,/std::env|read_to_string|println!|eprintln!|log::|Sites|with_sites_authorization/);
});
test('existing consumer prioritises durable recovery and never executes review proposals', () => {
  const functionBody=consumer.slice(consumer.indexOf('async fn advance_quote_work_round_with'));
  assert.ok(functionBody.indexOf('recovery_work(store')<functionBody.indexOf('protocol::discovery_request'));
  assert.match(functionBody,/if prepared\.disposition == protocol::QuoteWorkDisposition::NeedsReview \{\s*review_required \+= 1;\s*continue;/);
  assert.match(functionBody,/Do not advance the continuation on any failed await or partial page/);
  assert.doesNotMatch(native,/DELETE|UPDATE|INSERT|uncertain.*=|started.*=/);
});
