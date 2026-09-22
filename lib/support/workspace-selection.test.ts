import {expect,it} from 'vitest';
import {selectSupportWorkspace} from './workspace-selection';
it('honors the Gestion company when another Support company was most recently used',()=>{
  expect(selectSupportWorkspace([{id:'other'},{id:'right'}],null,'org-a',[{workspace_id:'right'}])?.id).toBe('right');
});
it('never falls back to another company or a workspace outside the user membership',()=>{
  const accessible=[{id:'other'}];
  expect(selectSupportWorkspace(accessible,null,'org-a',[{workspace_id:'secret'}])).toBeUndefined();
  expect(selectSupportWorkspace(accessible,'other','org-a',[{workspace_id:'secret'}])).toBeUndefined();
  expect(selectSupportWorkspace(accessible,'secret',null,[])).toBeUndefined();
  expect(selectSupportWorkspace(accessible,null,'org-a',[])).toBeUndefined();
});
