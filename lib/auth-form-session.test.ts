import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const formHost = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = [], effects: (() => void)[] = [];
  let cursor = 0, dirty = false;
  return {
    reset() { slots.length = 0; effects.length = 0; cursor = 0; dirty = false; },
    start() { cursor = 0; dirty = false; },
    get dirty() { return dirty; },
    useState(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: initial };
      return [slots[index].value, (next: unknown) => {
        const value = typeof next === 'function' ? next(slots[index].value) : next;
        if (!Object.is(value, slots[index].value)) { slots[index].value = value; dirty = true; }
      }];
    },
    useRef(initial: unknown) {
      const index = cursor++;
      if (!slots[index]) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect(effect: () => (() => void) | undefined, deps: readonly unknown[]) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, key) => !Object.is(value, previous.deps?.[key]))) {
        const next: Slot = { deps }; slots[index] = next;
        effects.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
      }
    },
    runEffects() { for (const effect of effects.splice(0)) effect(); },
    unmount() { for (const slot of slots) slot?.cleanup?.(); },
  };
});
vi.mock('react', () => formHost);
vi.mock('react/jsx-runtime', () => ({ jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }), Fragment: 'fragment' }));
vi.mock('lucide-react', () => Object.fromEntries(['ArrowRight','CheckCircle2','Eye','EyeOff','LoaderCircle','LockKeyhole','Mail','UserRound'].map(name => [name, name])));
import { loadAuthFormSession } from './auth-form-session';
import { ZentraAuthForm } from '@/components/zentra-auth-form';

type FormNode = {type?:unknown;props?:Record<string,unknown>};
let formTree: FormNode;
function renderForm() {
  formHost.start();
  formTree = ZentraAuthForm({returnTo:'/compte',initialError:''}) as unknown as FormNode;
  formHost.runEffects();
}
async function settleForm() {
  for (let turn=0;turn<10;turn++) {
    for(let tick=0;tick<8;tick++) await Promise.resolve();
    if(!formHost.dirty)return;
    renderForm();
  }
  throw Error('Form did not settle');
}
function formNode(predicate:(node:FormNode)=>boolean):FormNode|undefined {
  function walk(value:unknown):FormNode|undefined {
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){for(const child of value){const found=walk(child);if(found)return found;}return;}
    const node=value as FormNode;
    return predicate(node)?node:walk(node.props?.children);
  }
  return walk(formTree);
}

describe('sign-in page restored in another tab', () => {
  it('preserves a new login when old switch-account tabs reopen', async () => {
    let authenticated = false;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'GET') authenticated = false;
      return Response.json({ authenticated, ...(authenticated ? {user:{email:'owner@example.test'}} : {}) });
    });
    const signal = new AbortController().signal;
    expect((await loadAuthFormSession(signal, fetcher)).authenticated).toBe(false);
    authenticated = true; // Explicit successful sign-in in the other tab.
    for (let tab = 0; tab < 4; tab++) {
      expect(await loadAuthFormSession(signal, fetcher)).toEqual({authenticated:true,user:{email:'owner@example.test'}});
    }
    expect(fetcher.mock.calls.every(([url, init]) => url === '/api/auth/session' && init?.method === 'GET')).toBe(true);
  });
  it('reports service errors without silently signing out', async () => {
    const fetcher = vi.fn(async () => new Response('', {status:503}));
    await expect(loadAuthFormSession(new AbortController().signal, fetcher)).rejects.toThrow('session');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('bounded initial sign-in verification', () => {
  beforeEach(() => { formHost.reset(); vi.useFakeTimers(); });
  afterEach(() => { formHost.unmount(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('unlocks the real form after a stalled GET so an explicit sign-in can recover', async () => {
    const assign=vi.fn(), notify=vi.fn();
    vi.stubGlobal('window',{location:{assign},localStorage:{setItem:notify}});
    class SyntheticFormData extends FormData {
      constructor(){super();this.set('email','synthetic@example.test');this.set('password','synthetic-password');}
    }
    vi.stubGlobal('FormData',SyntheticFormData);
    const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => {
      if(init?.method==='POST')return Response.json({authenticated:true});
      // No headers or response ever arrive naturally; only fetch cancellation settles it.
      return await new Promise<Response>((_resolve,reject) => {
        init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
      });
    });
    vi.stubGlobal('fetch',fetcher);
    renderForm();await settleForm();
    expect(formNode(node=>node.props?.type==='submit')?.props?.disabled).toBe(true);
    expect(formNode(node=>node.props?.role==='tab')?.props?.disabled).toBe(true);
    await vi.advanceTimersByTimeAsync(15000);await settleForm();
    expect(formNode(node=>node.props?.role==='alert')?.props?.children).toBe('La session n’a pas pu être vérifiée. Réessayez.');
    expect(formNode(node=>node.props?.type==='submit')?.props?.disabled).toBe(false);
    expect(formNode(node=>node.props?.role==='tab')?.props?.disabled).toBe(false);
    const submit=formNode(node=>node.type==='form')?.props?.onSubmit;
    if(typeof submit!=='function')throw Error('Sign-in form missing');
    submit({preventDefault:vi.fn(),currentTarget:{reset:vi.fn()}});await settleForm();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][0]).toBe('/api/auth/connexion');
    expect(assign).toHaveBeenCalledWith('/compte');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates cleanup cancellation and removes the deadline timer', async () => {
    const controller=new AbortController();
    let receivedSignal:AbortSignal|undefined;
    const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => new Promise<Response>((_resolve,reject)=>{
      receivedSignal=init?.signal??undefined;
      receivedSignal!.addEventListener('abort',()=>reject(receivedSignal!.reason),{once:true});
    }));
    const request=loadAuthFormSession(controller.signal,fetcher);
    const rejected=expect(request).rejects.toMatchObject({name:'AbortError'});
    controller.abort();await rejected;
    expect(receivedSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('also bounds a body read whose headers have already arrived', async () => {
    const fetcher=vi.fn(async (_url:RequestInfo|URL,init?:RequestInit) => ({ok:true,json:()=>new Promise((_resolve,reject)=>{
      init!.signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});
    })}) as Response);
    const request=loadAuthFormSession(new AbortController().signal,fetcher);
    const rejected=expect(request).rejects.toThrow('La session n’a pas pu être vérifiée. Réessayez.');
    await vi.advanceTimersByTimeAsync(15000);await rejected;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
