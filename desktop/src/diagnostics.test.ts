import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const invoke = vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
async function api(){return import('./diagnostics');}
beforeEach(()=>{vi.resetModules();invoke.mockReset();vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('safe diagnostics',()=>{
  it('preserves command arguments, options, result and paired operation identity',async()=>{
    const d=await api(),result={private:'document data'};invoke.mockResolvedValue(result);
    expect(await d.diagnosticInvoke('save_quote',{password:'secret',notes:'customer text'})).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('save_quote',{password:'secret',notes:'customer text'});
    const events=d.recentDiagnosticEvents();expect(events).toHaveLength(2);expect(events[0].id).toBe(events[1].id);expect(events[1].phase).toBe('success');expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toMatch(/secret|customer text|document data|password|notes/);
    await d.diagnosticInvoke('load_workspace');expect(invoke.mock.calls[1]).toEqual(['load_workspace']);
    await d.diagnosticInvoke('watch_workspace',{}, {headers:{foo:'bar'}});expect(invoke.mock.calls[2]).toEqual(['watch_workspace',{}, {headers:{foo:'bar'}}]);
  });
  it('rethrows the original error and correlates both object and displayed string',async()=>{
    const d=await api(),error=new Error('network failure for customer@example.ch password=secret');invoke.mockRejectedValue(error);
    await expect(d.diagnosticInvoke('get_account')).rejects.toBe(error);
    const events=d.recentDiagnosticEvents();expect(events[1].errorCode).toBe('NETWORK');
    expect(d.resolveErrorIncident(error).code).toBe(`ZT-${events[1].id}`);expect(d.resolveErrorIncident(error.message).code).toBe(`ZT-${events[1].id}`);
    expect(d.recentDiagnosticEvents()).toHaveLength(2);expect(JSON.stringify(events)).not.toMatch(/customer|example|password|secret/);
  });
  it('ignores arbitrary payload fields and malformed operation names',async()=>{
    const d=await api();d.recordDiagnostic({area:'draft',operation:'form.capture',phase:'info',durationMs:Infinity,errorCode:'secret',payload:{password:'secret'}} as never);
    d.recordDiagnostic({area:'command',operation:'customer@example.ch',phase:'start'});
    expect(d.recentDiagnosticEvents()).toHaveLength(1);expect(Object.keys(d.recentDiagnosticEvents()[0])).toEqual(['id','sessionId','timestamp','area','operation','phase']);
  });
  it('bounds memory and timings without changing business operations',async()=>{
    const d=await api();for(let i=0;i<1000;i++)d.recordDiagnostic({area:'app',operation:'screen.open',phase:'info',durationMs:90000000});
    expect(d.recentDiagnosticEvents()).toHaveLength(300);expect(d.recentDiagnosticEvents()[0].durationMs).toBe(86400000);
    const copy=d.recentDiagnosticEvents();(copy[0] as {operation:string}).operation='modified';expect(d.recentDiagnosticEvents()[0].operation).toBe('screen.open');
  });
  it('keeps transport batches bounded and does not recursively log journal calls',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const d=await api();invoke.mockResolvedValue(undefined);
    for(let i=0;i<650;i++)d.recordDiagnostic({area:'sync',operation:'company.checked',phase:'info'});
    await d.flushDiagnostics();expect(invoke).toHaveBeenCalledTimes(5);expect(invoke.mock.calls.every(call=>call[0]==='append_diagnostic_events'&&call[1].events.length===100)).toBe(true);
    const count=d.recentDiagnosticEvents().length;await d.diagnosticInvoke('get_diagnostics_summary');expect(d.recentDiagnosticEvents()).toHaveLength(count);
  });
  it('journal write failures never break a successful command and export retries the pending log',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const d=await api();let fail=true;
    invoke.mockImplementation(async(command:string)=>{if(command==='append_diagnostic_events'&&fail)throw new Error('disk full');return command==='export_diagnostics'?'/exports/diagnostic.jsonl':'saved';});
    expect(await d.diagnosticInvoke('save_invoice')).toBe('saved');await d.flushDiagnostics();
    await expect(d.diagnosticsApi.export()).rejects.toThrow('diagnostic récent');expect(invoke.mock.calls.some(call=>call[0]==='export_diagnostics')).toBe(false);
    fail=false;expect(await d.diagnosticsApi.export()).toBe('/exports/diagnostic.jsonl');
    const last=invoke.mock.calls.at(-2);expect(last?.[0]).toBe('append_diagnostic_events');expect(last?.[1].events.map((event:{phase:string})=>event.phase)).toEqual(['start','success']);
  });
  it('clear only discards pending events after native clearing succeeds',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const d=await api();d.recordDiagnostic({area:'app',operation:'client.startup',phase:'info'});
    invoke.mockImplementation(async(command:string)=>{if(command==='clear_diagnostics')throw new Error('disk');});
    await expect(d.diagnosticsApi.clear()).rejects.toThrow('disk');expect(d.recentDiagnosticEvents()).toHaveLength(1);
    invoke.mockResolvedValue(undefined);await d.diagnosticsApi.clear();expect(d.recentDiagnosticEvents()).toHaveLength(0);
  });
  it.each([['network timeout','NETWORK'],['401 unauthorized','SESSION'],['403 forbidden','PERMISSION'],['409 conflict','CONFLICT'],['Champ invalide','VALIDATION'],['sqlite locked','STORAGE'],['not found','NOT_FOUND'],['unknown failure','INTERNAL']])('categorises %s without retaining its text',async(message,code)=>{
    expect((await api()).classifyDiagnosticError(message)).toBe(code);
  });
});
