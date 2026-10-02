import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const invoke = vi.hoisted(()=>vi.fn());
vi.mock('@tauri-apps/api/core',()=>({invoke}));
async function api(){return import('./diagnostics');}
const hostileErrors = [
  ['message getter', () => {
    const original=new Error(''),accessFailure=new Error('');
    Object.defineProperty(original,'message',{get(){throw accessFailure;}});
    return {original,accessFailure};
  }],
  ['prototype trap', () => {
    const accessFailure=new Error('');
    const original=new Proxy(new Error(''),{getPrototypeOf(){throw accessFailure;}});
    return {original,accessFailure};
  }],
] as const;
function coercionError(accessor:boolean,method:'primitive'|'string'){
  const original=new Error(''),accessFailure=new Error('');
  const message:object=method==='primitive'?{[Symbol.toPrimitive](){throw accessFailure;}}:{toString(){throw accessFailure;}};
  Object.defineProperty(original,'message',accessor?{get(){return message;}}:{value:message});
  return {original,accessFailure};
}
const coercionErrors = [
  ['primitive message value',()=>coercionError(false,'primitive')],
  ['primitive message accessor',()=>coercionError(true,'primitive')],
  ['string message value',()=>coercionError(false,'string')],
  ['string message accessor',()=>coercionError(true,'string')],
] as const;
beforeEach(()=>{vi.resetModules();invoke.mockReset();vi.useFakeTimers();});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
describe('safe diagnostics',()=>{
  it.each([...hostileErrors,...coercionErrors])('keeps an operation rejection when its %s throws',async(_label,create)=>{
    const d=await api(),{original}=create();
    const preserved=await d.diagnosticOperation('command','read_workspace',async()=>{throw original;}).catch(reason=>reason===original);
    expect(preserved).toBe(true);
    const events=d.recentDiagnosticEvents();
    expect(events.map(event=>event.phase)).toEqual(['start','failure']);
    expect(events[1].errorCode).toBe('INTERNAL');
    expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
    expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
    expect(d.recentDiagnosticEvents()).toHaveLength(2);
  });
  it.each([...hostileErrors,...coercionErrors])('keeps the native rejection when its %s throws',async(_label,create)=>{
    const d=await api(),{original}=create();
    invoke.mockRejectedValue(original);
    const preserved=await d.diagnosticInvoke('read_workspace',{scope:'synthetic-scope'}).catch(reason=>reason===original);
    expect(preserved).toBe(true);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('read_workspace',{scope:'synthetic-scope'});
    const events=d.recentDiagnosticEvents();
    expect(events.map(event=>event.phase)).toEqual(['start','failure']);
    expect(d.resolveErrorIncident(original).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toContain('synthetic-scope');
  });
  it.each(coercionErrors)('classifies a hostile %s without propagating its coercion failure',async(_label,create)=>{
    const d=await api(),{original,accessFailure}=create();
    let code:string|undefined,accessFailureEscaped=false;
    try{code=d.classifyDiagnosticError(original);}catch(reason){accessFailureEscaped=reason===accessFailure;}
    expect({code,accessFailureEscaped}).toEqual({code:'INTERNAL',accessFailureEscaped:false});
  });
  it.each([
    ['numeric message',401,'SESSION'],
    ['coercible message',{toString(){return 'network timeout';}},'NETWORK'],
  ] as const)('keeps classification for a %s',async(_label,message,expected)=>{
    const d=await api(),original=new Error('');
    Object.defineProperty(original,'message',{value:message});
    expect(d.classifyDiagnosticError(original)).toBe(expected);
    const preserved=await d.diagnosticOperation('command','read_workspace',async()=>{throw original;}).catch(reason=>reason===original);
    expect(preserved).toBe(true);
    expect(d.recentDiagnosticEvents()[1].errorCode).toBe(expected);
  });
  it('traces plugin work without retaining its result and rethrows the original failure',async()=>{
    const d=await api(), result='/Users/private/secret-invoice.pdf';
    expect(await d.diagnosticOperation('command','dialog.open_file',async()=>result)).toBe(result);
    const error=new Error('disk full for customer@example.ch password=secret');
    await expect(d.diagnosticOperation('command','file.materialize_mobile',async()=>{throw error;})).rejects.toBe(error);
    const events=d.recentDiagnosticEvents();
    expect(events.map(event=>event.phase)).toEqual(['start','success','start','failure']);
    expect(events[2].id).toBe(events[3].id);
    expect(d.resolveErrorIncident(error).code).toBe(`ZT-${events[3].id}`);
    expect(events[3].errorCode).toBe('STORAGE');
    expect(JSON.stringify(events)).not.toMatch(/private|invoice.pdf|customer|password|secret/);
  });

  it('treats an explicitly cancelled file picker as a completed choice without inventing an error',async()=>{
    const d=await api();
    expect(await d.diagnosticOperation('command','dialog.open_file',async()=>null)).toBeNull();
    expect(d.recentDiagnosticEvents().map(event=>event.phase)).toEqual(['start','success']);
    expect(d.recentDiagnosticEvents()[1].errorCode).toBeUndefined();
  });

  it('preserves command arguments, options, result and paired operation identity',async()=>{
    const d=await api(),result={private:'document data'};invoke.mockResolvedValue(result);
    expect(await d.diagnosticInvoke('save_quote',{password:'secret',notes:'customer text'})).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('save_quote',{password:'secret',notes:'customer text'});
    const events=d.recentDiagnosticEvents();expect(events).toHaveLength(2);expect(events[0].id).toBe(events[1].id);expect(events[1].phase).toBe('success');expect(events[1].durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(events)).not.toMatch(/secret|customer text|document data|password|notes/);
    await d.diagnosticInvoke('load_workspace');expect(invoke.mock.calls[1]).toEqual(['load_workspace']);
    await d.diagnosticInvoke('watch_workspace',{}, {headers:{foo:'bar'}});expect(invoke.mock.calls[2]).toEqual(['watch_workspace',{}, {headers:{foo:'bar'}}]);
  });
  it('logs the known iOS navigation command with a fixed slug while forwarding its exact transport input',async()=>{
    const d=await api(),command='plugin:zentra-mobile|configure_navigation';
    const args={selected:'agenda',visible:true,items:[{id:'agenda',label:'Private company navigation'}],onNavigate:{privateChannel:'callback-id'}};
    const options={headers:{privateHeader:'private-value'}},result={available:true};invoke.mockResolvedValue(result);
    expect(await d.diagnosticInvoke(command,args,options)).toBe(result);
    expect(invoke).toHaveBeenCalledExactlyOnceWith(command,args,options);
    const events=d.recentDiagnosticEvents();
    expect(events.map(event=>[event.operation,event.phase])).toEqual([['plugin.zentra_mobile.configure_navigation','start'],['plugin.zentra_mobile.configure_navigation','success']]);
    expect(events[0].id).toBe(events[1].id);
    expect(JSON.stringify(events)).not.toMatch(/selected|visible|agenda|Private|private|items|onNavigate|callback|available/);
  });
  it('records an iOS navigation failure and keeps the original rejection without allowing arbitrary plugin names',async()=>{
    const d=await api(),reason='native navigation unavailable for customer@example.ch password=secret';invoke.mockRejectedValue(reason);
    await expect(d.diagnosticInvoke('plugin:zentra-mobile|configure_navigation',{selected:'invoices',visible:true})).rejects.toBe(reason);
    const events=d.recentDiagnosticEvents();
    expect(events.map(event=>[event.operation,event.phase])).toEqual([['plugin.zentra_mobile.configure_navigation','start'],['plugin.zentra_mobile.configure_navigation','failure']]);
    expect(events[0].id).toBe(events[1].id);
    expect(d.resolveErrorIncident(reason).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/invoices|selected|visible|customer|password|secret/);
    invoke.mockResolvedValue('unchanged');
    expect(await d.diagnosticInvoke('plugin:private-customer|secret-command',{password:'secret'})).toBe('unchanged');
    expect(d.recentDiagnosticEvents()).toHaveLength(2);
  });
  it('rethrows the original error and correlates both object and displayed string',async()=>{
    const d=await api(),error=new Error('network failure for customer@example.ch password=secret');invoke.mockRejectedValue(error);
    await expect(d.diagnosticInvoke('get_account')).rejects.toBe(error);
    const events=d.recentDiagnosticEvents();expect(events[1].errorCode).toBe('NETWORK');
    expect(d.resolveErrorIncident(error).code).toBe(`ZT-${events[1].id}`);expect(d.resolveErrorIncident(error.message).code).toBe(`ZT-${events[1].id}`);
    expect(d.recentDiagnosticEvents()).toHaveLength(2);expect(JSON.stringify(events)).not.toMatch(/customer|example|password|secret/);
  });
  it('does not associate equal strings from concurrent failures with either source arbitrarily',async()=>{
    const d=await api(), reason='network failure for customer@example.ch password=secret';
    let rejectQuote!:(reason:unknown)=>void,rejectInvoice!:(reason:unknown)=>void;
    const quote=d.diagnosticOperation('command','save_quote',()=>new Promise<never>((_,reject)=>{rejectQuote=reject;})).catch(error=>error);
    const invoice=d.diagnosticOperation('command','save_invoice',()=>new Promise<never>((_,reject)=>{rejectInvoice=reject;})).catch(error=>error);
    rejectQuote(reason);expect(await quote).toBe(reason);
    rejectInvoice(reason);expect(await invoice).toBe(reason);
    const failures=d.recentDiagnosticEvents().filter(event=>event.phase==='failure');
    expect(failures).toHaveLength(2);
    expect(failures[0].id).not.toBe(failures[1].id);
    const presented=d.resolveErrorIncident(reason).code;
    expect(failures.map(event=>`ZT-${event.id}`)).not.toContain(presented);
    expect(d.recentDiagnosticEvents().at(-1)).toMatchObject({operation:'client.present_error',phase:'failure',errorCode:'NETWORK'});
    expect(presented).toBe(`ZT-${d.recentDiagnosticEvents().at(-1)?.id}`);
    const count=d.recentDiagnosticEvents().length;
    expect(d.resolveErrorIncident(reason).code).toBe(presented);
    expect(d.resolveErrorIncident(reason).code).toBe(presented);
    expect(d.recentDiagnosticEvents()).toHaveLength(count);
    expect(JSON.stringify(d.recentDiagnosticEvents())).not.toMatch(/customer|example|password|secret/);
  });
  it('keeps object identities precise when their equal messages have an ambiguous association',async()=>{
    const d=await api(), first=new Error('Failed to fetch'),second=new Error('Failed to fetch');
    await expect(d.diagnosticOperation('command','save_quote',async()=>{throw first;})).rejects.toBe(first);
    await expect(d.diagnosticOperation('command','save_invoice',async()=>{throw second;})).rejects.toBe(second);
    const failures=d.recentDiagnosticEvents().filter(event=>event.phase==='failure');
    expect(d.resolveErrorIncident(first).code).toBe(`ZT-${failures[0].id}`);
    expect(d.resolveErrorIncident(second).code).toBe(`ZT-${failures[1].id}`);
    const messageIncident=d.resolveErrorIncident(first.message).code;
    expect(failures.map(event=>`ZT-${event.id}`)).not.toContain(messageIncident);
    expect(d.resolveErrorIncident(second.message).code).toBe(messageIncident);
    expect(d.resolveErrorIncident(first).code).toBe(`ZT-${failures[0].id}`);
    expect(d.resolveErrorIncident(second).code).toBe(`ZT-${failures[1].id}`);
    expect(d.recentDiagnosticEvents()).toHaveLength(5);
  });
  it('keeps a presentation reference stable if another matching failure arrives later',async()=>{
    const d=await api(),reason='Failed to fetch';
    for(const command of ['save_quote','save_invoice'])await expect(d.diagnosticOperation('command',command,async()=>{throw reason;})).rejects.toBe(reason);
    const presented=d.resolveErrorIncident(reason).code;
    await expect(d.diagnosticOperation('command','get_workspace',async()=>{throw reason;})).rejects.toBe(reason);
    const count=d.recentDiagnosticEvents().length;
    expect(d.resolveErrorIncident(reason).code).toBe(presented);
    expect(d.recentDiagnosticEvents()).toHaveLength(count);
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
  it('resets object and string incident associations only after a successful native clear',async()=>{
    vi.stubGlobal('window',{__TAURI_INTERNALS__:{}});const d=await api(),error=new Error('network failure');
    invoke.mockResolvedValue(undefined);
    await expect(d.diagnosticOperation('command','get_workspace',async()=>{throw error;})).rejects.toBe(error);
    const original=d.resolveErrorIncident(error).code;
    expect(d.resolveErrorIncident(error.message).code).toBe(original);
    invoke.mockImplementation(async(command:string)=>{if(command==='clear_diagnostics')throw new Error('disk');});
    await expect(d.diagnosticsApi.clear()).rejects.toThrow('disk');
    expect(d.resolveErrorIncident(error).code).toBe(original);
    expect(d.resolveErrorIncident(error.message).code).toBe(original);
    expect(d.recentDiagnosticEvents()).toHaveLength(2);
    invoke.mockResolvedValue(undefined);
    await d.diagnosticsApi.clear();expect(d.recentDiagnosticEvents()).toHaveLength(0);
    const renewed=d.resolveErrorIncident(error).code;
    expect(renewed).not.toBe(original);
    expect(d.resolveErrorIncident(error.message).code).toBe(renewed);
    expect(d.recentDiagnosticEvents()).toHaveLength(1);
    expect(d.recentDiagnosticEvents()[0]).toMatchObject({operation:'client.present_error',phase:'failure',errorCode:'NETWORK'});
  });
  it.each([['network timeout','NETWORK'],['401 unauthorized','SESSION'],['403 forbidden','PERMISSION'],['409 conflict','CONFLICT'],['Champ invalide','VALIDATION'],['sqlite locked','STORAGE'],['not found','NOT_FOUND'],['unknown failure','INTERNAL']])('categorises %s without retaining its text',async(message,code)=>{
    expect((await api()).classifyDiagnosticError(message)).toBe(code);
  });
  it.each([
    'La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.',
    'L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.',
  ])('records a fixed workspace rejection as CONFLICT without retaining its text: %s', async message => {
    const d = await api(), reason = new Error(`Champ invalide : ${message} token=private-secret synthetic-org synthetic-scope`);
    expect(d.classifyDiagnosticError(message)).toBe('CONFLICT');
    expect(d.classifyDiagnosticError(reason)).toBe('CONFLICT');
    expect(d.classifyDiagnosticError(reason.message.replaceAll('’', "'"))).toBe('CONFLICT');
    await expect(d.diagnosticOperation('command', 'supplier_inbox_request', async () => { throw reason; })).rejects.toBe(reason);
    const events = d.recentDiagnosticEvents();
    expect(events.map(event => event.phase)).toEqual(['start', 'failure']);
    expect(events[1].errorCode).toBe('CONFLICT');
    expect(events[0].id).toBe(events[1].id);
    expect(d.resolveErrorIncident(reason).code).toBe(`ZT-${events[1].id}`);
    expect(JSON.stringify(events)).not.toMatch(/Champ invalide|entreprise ouverte|private-secret|synthetic-org|synthetic-scope|token/);
  });
  it.each([[401, 'SESSION'], [403, 'PERMISSION']])('keeps auth code %s ahead of a fixed workspace rejection', async (status, code) => {
    const message = `${status} Champ invalide : La connexion ou l’entreprise ouverte a changé. Rouvrez la réception.`;
    expect((await api()).classifyDiagnosticError(message)).toBe(code);
  });
  it('does not mark unrelated company field validation as a workspace conflict', async () => {
    expect((await api()).classifyDiagnosticError('Champ invalide : Le nom de l’entreprise doit être complété.')).toBe('VALIDATION');
  });
});

describe('diagnostic transport retry', () => {
  function pending<T>() {
    let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }
  const appends = () => invoke.mock.calls.filter(call => call[0] === 'append_diagnostic_events');
  beforeEach(() => {
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  });
  it.each([false, true])('recovers in silence after backoff, event during backoff=%s', async addEvent => {
    const d = await api();
    invoke.mockRejectedValueOnce(new Error('synthetic log storage failure')).mockResolvedValue(undefined);
    const id = d.recordDiagnostic({ area: 'app', operation: 'client.startup', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300); expect(appends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    if (addEvent) d.recordDiagnostic({ area: 'navigation', operation: 'screen.settings', phase: 'info' });
    await vi.advanceTimersByTimeAsync(28999); expect(appends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(appends()).toHaveLength(2);
    expect(appends()[1][1].events.map((event: { id: string }) => event.id)).toContain(id);
    expect(appends()[1][1].events).toHaveLength(addEvent ? 2 : 1); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds repeated failures, event storms and retry frequency without retaining private input', async () => {
    const d = await api(), times: number[] = []; let fail = true;
    invoke.mockImplementation(async () => { times.push(Date.now()); if (fail) throw new Error('password=synthetic-secret'); });
    d.recordDiagnostic({ area: 'app', operation: 'client.startup', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300);
    for (let index = 0; index < 650; index++) d.recordDiagnostic({ area: 'sync', operation: 'company.checked', phase: 'info', payload: { password: 'synthetic-secret' } } as never);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29999); expect(appends()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1); expect(appends()).toHaveLength(2);
    expect(times[1] - times[0]).toBe(30000); expect(vi.getTimerCount()).toBe(1);
    fail = false; await vi.advanceTimersByTimeAsync(30000);
    expect(appends()).toHaveLength(7); expect(vi.getTimerCount()).toBe(0);
    expect(appends().slice(2).flatMap(call => call[1].events)).toHaveLength(500);
    expect(appends().every(call => call[1].events.length <= 100)).toBe(true);
    expect(d.recentDiagnosticEvents()).toHaveLength(300);
    expect(JSON.stringify(appends())).not.toMatch(/password|synthetic-secret|payload/);
  });
  it('shares a forced flush with concurrent callers and replaces obsolete backoff after recovery', async () => {
    const d = await api(), held = pending<void>(); let attempt = 0, active = 0, maximum = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'export_diagnostics') return '/synthetic/diagnostics.jsonl';
      if (command !== 'append_diagnostic_events') return;
      attempt++; active++; maximum = Math.max(maximum, active);
      try { if (attempt === 1) throw new Error('synthetic storage failure'); if (attempt === 2) await held.promise; }
      finally { active--; }
    });
    d.recordDiagnostic({ area: 'app', operation: 'client.startup', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300);
    const exported = d.diagnosticsApi.export(), forced = d.flushDiagnostics(true), ordinary = d.flushDiagnostics();
    d.recordDiagnostic({ area: 'navigation', operation: 'screen.settings', phase: 'info' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000); expect(appends()).toHaveLength(2); expect(maximum).toBe(1);
    held.resolve(undefined); await Promise.all([forced, ordinary]);
    expect(await exported).toBe('/synthetic/diagnostics.jsonl');
    expect(appends()).toHaveLength(3); expect(maximum).toBe(1); expect(vi.getTimerCount()).toBe(0);
    d.recordDiagnostic({ area: 'navigation', operation: 'screen.home', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300); expect(appends()).toHaveLength(4);
    expect(invoke.mock.calls.filter(call => call[0] === 'export_diagnostics')).toHaveLength(1);
  });
  it('pauses retries throughout clearing and never sends a successfully erased lot', async () => {
    const d = await api(), cleared = pending<void>(); let attempt = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'append_diagnostic_events' && ++attempt === 1) throw new Error('synthetic storage failure');
      if (command === 'clear_diagnostics') await cleared.promise;
    });
    d.recordDiagnostic({ area: 'app', operation: 'client.startup', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300);
    const clearing = d.diagnosticsApi.clear(); await Promise.resolve();
    d.recordDiagnostic({ area: 'navigation', operation: 'screen.settings', phase: 'info' });
    await d.flushDiagnostics(true); await vi.advanceTimersByTimeAsync(31000);
    expect(appends()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    cleared.resolve(undefined); await clearing;
    expect(d.recentDiagnosticEvents()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
    d.recordDiagnostic({ area: 'navigation', operation: 'screen.home', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300);
    expect(appends()).toHaveLength(2); expect(appends()[1][1].events.map((event: { operation: string }) => event.operation)).toEqual(['screen.home']);
  });
  it('keeps the original clear failure and resumes pending incidents without replaying business work', async () => {
    const d = await api(), cleared = pending<void>(), clearFailure = new Error('synthetic clear failure'), original = new Error('network password=synthetic-secret');
    let attempt = 0, businessCalls = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command === 'append_diagnostic_events' && ++attempt === 1) throw new Error('synthetic storage failure');
      if (command === 'clear_diagnostics') await cleared.promise;
    });
    await expect(d.diagnosticOperation('command', 'save_quote', async () => { businessCalls++; throw original; })).rejects.toBe(original);
    const incident = d.resolveErrorIncident(original).code;
    await vi.advanceTimersByTimeAsync(300);
    const clearing = d.diagnosticsApi.clear().catch(reason => reason); await vi.advanceTimersByTimeAsync(31000);
    expect(appends()).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    cleared.reject(clearFailure); expect(await clearing).toBe(clearFailure);
    expect(vi.getTimerCount()).toBe(1); await vi.advanceTimersByTimeAsync(300);
    expect(appends()).toHaveLength(2); expect(businessCalls).toBe(1);
    const events = appends()[1][1].events;
    expect(events.map((event: { phase: string }) => event.phase)).toEqual(['start', 'failure']);
    expect(incident).toBe('ZT-' + events[1].id); expect(d.resolveErrorIncident(original).code).toBe(incident);
    expect(JSON.stringify(events)).not.toMatch(/password|synthetic-secret/); expect(vi.getTimerCount()).toBe(0);
  });
  it('waits for an active forced append before clearing even during backoff', async () => {
    const d = await api(), held = pending<void>(); let attempt = 0;
    invoke.mockImplementation(async (command: string) => {
      if (command !== 'append_diagnostic_events') return;
      if (++attempt === 1) throw new Error('synthetic storage failure'); await held.promise;
    });
    d.recordDiagnostic({ area: 'app', operation: 'client.startup', phase: 'info' });
    await vi.advanceTimersByTimeAsync(300);
    const forced = d.flushDiagnostics(true), clearing = d.diagnosticsApi.clear();
    await Promise.resolve(); await Promise.resolve();
    expect(invoke.mock.calls.some(call => call[0] === 'clear_diagnostics')).toBe(false);
    held.resolve(undefined); await Promise.all([forced, clearing]);
    expect(invoke.mock.calls.filter(call => call[0] === 'clear_diagnostics')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(31000); expect(appends()).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
  });
});
