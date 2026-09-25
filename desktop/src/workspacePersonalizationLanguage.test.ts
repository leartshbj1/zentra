import { expect, it } from 'vitest';
import { translations } from './translations';
import { shortcutMeta, quickActionMeta } from './WorkspacePersonalization';
import { companySyncPresentation } from './companySyncPresentation';
it('translates every selectable destination, quick action and synchronization message', () => {
  const statuses = [
    companySyncPresentation({enabled:false,revision:0,pending:false,conflict:false},'a',true),
    ...[{}, {pending:true}, {ready:true}, {conflict:true}, {error:'401'}, {lastSyncedAt:undefined}].map(patch=>companySyncPresentation({enabled:true,organizationId:'a',revision:1,pending:false,conflict:false,lastSyncedAt:new Date().toISOString(),...patch},'a',true)),
    companySyncPresentation({enabled:false,revision:0,pending:false,conflict:false},'a',false),
  ];
  const labels = [...Object.values(shortcutMeta), ...Object.values(quickActionMeta)].map(item=>item.label).filter(label=>label!=='Automation');
  expect([...labels, ...statuses.flatMap(state=>[state.label,state.detail])].filter(key=>translations[key]?.length!==3||translations[key].some(value=>!value.trim()))).toEqual([]);
});
