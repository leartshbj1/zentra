import { describe, expect, it } from 'vitest';
import { availableShortcuts, defaultPreferences, parseWorkspacePreferences, replaceShortcut, selectedShortcut } from './workspacePreferences';

describe('personal shortcuts', () => {
  it.each([null, 'broken json', '{"version":99}', 'null'])('recovers invalid storage without blocking navigation: %s', raw => {
    expect(parseWorkspacePreferences(raw)).toEqual(defaultPreferences);
  });
  it('repairs duplicate, obsolete and malformed entries to four known shortcuts', () => {
    const value = parseWorkspacePreferences(JSON.stringify({ version:1, shortcuts:['automation','automation','removed',12,'clients'], actions:['purchase','purchase',null,'employee'] }));
    expect(value.shortcuts).toEqual(['automation','clients','dashboard','projects']);
    expect(value.actions).toEqual(['purchase','employee','client','project']);
  });
  it('keeps paid feature preference without displaying it in a different company', () => {
    const value = parseWorkspacePreferences(JSON.stringify({ version:1, shortcuts:['automation','clients','invoices','agenda'] }));
    expect(availableShortcuts(value,false)).toEqual(['clients','invoices','agenda','dashboard']);
    expect(availableShortcuts(value,true)).toEqual(value.shortcuts);
  });
  it('swaps occupied positions rather than duplicating or losing destinations', () => {
    expect(replaceShortcut(['a','b','c','d'],0,'c')).toEqual(['c','b','a','d']);
    expect(replaceShortcut(['a','b','c','d'],2,'e')).toEqual(['a','b','e','d']);
  });
  it('selects the explicit invoice shortcut before the broader sales group', () => {
    expect(selectedShortcut('invoices',['dashboard','quotes','invoices','agenda'])).toBe('invoices');
    expect(selectedShortcut('invoices',defaultPreferences.shortcuts)).toBe('quotes');
    expect(selectedShortcut('team',defaultPreferences.shortcuts)).toBe('menu');
  });
});
