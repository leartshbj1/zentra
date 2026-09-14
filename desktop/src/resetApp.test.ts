import {afterEach,it,expect,vi} from 'vitest';
import {clearLocalAppPreferences} from './resetApp';
afterEach(()=>vi.unstubAllGlobals());
it('clears drafts, session state and offline caches on the app origin',async()=>{
  const local={clear:vi.fn()},session={clear:vi.fn()},cache={keys:vi.fn(async()=>['zentra-qwen-gguf-v1']),delete:vi.fn(async()=>true)};
  vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',session);vi.stubGlobal('caches',cache);vi.stubGlobal('indexedDB',undefined);vi.stubGlobal('navigator',{storage:{}});
  await clearLocalAppPreferences();expect(local.clear).toHaveBeenCalledOnce();expect(session.clear).toHaveBeenCalledOnce();expect(cache.delete).toHaveBeenCalledWith('zentra-qwen-gguf-v1');
});
it('reports cache cleanup failures instead of silently announcing a complete reset',async()=>{
  vi.stubGlobal('localStorage',{clear:vi.fn()});vi.stubGlobal('sessionStorage',{clear:vi.fn()});vi.stubGlobal('caches',{keys:vi.fn(async()=>{throw new Error('Stockage indisponible');})});
  await expect(clearLocalAppPreferences()).rejects.toThrow('Stockage indisponible');
});
