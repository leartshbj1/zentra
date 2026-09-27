import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { scalableFontValue, scalableText } from '../build/scalableText';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
function environment(saved = '150') {
  const target = new EventTarget();
  const root = { dataset: {} as Record<string,string>, style: {setProperty: vi.fn()} };
  const storage = {getItem: vi.fn(() => saved),setItem: vi.fn()};
  vi.stubGlobal('window', target); vi.stubGlobal('document', {documentElement:root}); vi.stubGlobal('localStorage', storage);
  return {target,root,storage};
}
describe('device text size', () => {
  it('restores a valid size and follows changes or reset in another window', async () => {
    const {target,root,storage} = environment();
    const {setTextSize} = await import('./textSize');
    expect(root.style.setProperty).toHaveBeenLastCalledWith('--zentra-ui-text-scale','1.5');
    expect(setTextSize(200)).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith('zentra.text-size.v1','200');
    target.dispatchEvent(Object.assign(new Event('storage'),{key:'zentra.text-size.v1',newValue:'125'}));
    expect(root.dataset.appTextSize).toBe('125');
    target.dispatchEvent(Object.assign(new Event('storage'),{key:null,newValue:null}));
    expect(root.dataset.appTextSize).toBe('100');
  });
  it('rejects invalid persisted values and remains usable when persistence is denied', async () => {
    const {root,storage} = environment('9999');
    const {setTextSize} = await import('./textSize');
    expect(root.dataset.appTextSize).toBe('100');
    expect(setTextSize(9999 as 100)).toBe(false);
    storage.setItem.mockImplementation(() => {throw new Error('Storage blocked');});
    expect(setTextSize(175)).toBe(false);
    expect(root.dataset.appTextSize).toBe('175');
  });
  it.each(['100','125','150','175','200','-1','invalid'])('matches first paint to the preference %s', async saved => {
    const {root} = environment(saved);
    runInNewContext(readFileSync(new URL('../public/theme-init.js', import.meta.url),'utf8'),{
      document:{documentElement:root},matchMedia:()=>({matches:false}),localStorage:{getItem:()=>saved},
    });
    const firstSize=root.dataset.appTextSize;
    await import('./textSize');
    expect(root.dataset.appTextSize).toBe(firstSize);
  });
});
describe('text dimensions at build time', () => {
  it('scales lengths once and preserves relative inheritance and font names', () => {
    for(const value of ['14px','clamp(14px, 2vw, 1.5rem)','max(16px, 1em)','500 14px/20px "Type 12px"']) {
      const scaled=scalableFontValue(value);
      expect(scaled).toContain('--zentra-ui-text-scale');
      expect(scalableFontValue(scaled)).toBe(scaled);
    }
    expect(scalableFontValue('1.5')).toBe('1.5');
    expect(scalableFontValue('inherit')).toBe('inherit');
    expect(scalableFontValue('1.25em')).toBe('1.25em');
    expect(scalableFontValue('120%')).toBe('120%');
    expect(scalableFontValue('var(--document-12px)')).toBe('var(--document-12px)');
    expect(scalableFontValue('14px "Type 12px"')).toContain('"Type 12px"');
  });
  it('does not transform spacing, font faces, root rem, dependencies or fixture CSS', () => {
    const plugin=scalableText();
    const source={input:{file:'C:/workspace/desktop/src/example.css'}};
    const declaration={prop:'font-size',value:'14px',parent:{type:'rule',selector:'.button'},source};
    plugin.Declaration(declaration);
    expect(declaration.value).toContain('--zentra-ui-text-scale');
    for(const override of [{prop:'width'}, {parent:{type:'rule',selector:':root'}}, {parent:{type:'atrule',name:'font-face'}}, {source:{input:{file:'/desktop/node_modules/library.css'}}}, {source:{input:{file:'/desktop/tests/fixture.css'}}}]) {
      const untouched={...declaration,value:'14px',...override};
      plugin.Declaration(untouched);expect(untouched.value).toBe('14px');
    }
  });
});
