import { expect, it } from 'vitest';
import { assertAutopilotCatalogueMutationOrigin, autopilotCatalogueSkuExists, resolveAutopilotCatalogueEntry, resolveAutopilotCatalogueFollowup, type AutopilotCatalogueRequest } from './autopilotCatalogue';
import type { CatalogItem } from './types';
const identity = { companyId: 'workspace-a', organizationId: 'company-a', memberId: 'member-a', memberContextNonce: 'a'.repeat(32), ready: true };
const request: AutopilotCatalogueRequest = { organizationId: 'company-a', proposalId: 'proposal-a', sourceId: 'source-a',
  origin: { workspaceScope: 'workspace-a', memberContextNonce: 'a'.repeat(32) } };
const review = { proposalId: 'proposal-a', sourceId: 'source-a', createdAt: 1791947827,
  disposition: 'needs_review', reasons: ['missing_article'], requiresHumanValidation: true };
const page = { organizationId: 'company-a', items: [review], nextCursor: null };
const workspace = { workNotesScope: 'workspace-a' };
const current = { active: true, readOnly: false };
const article = { id: 'new-article', sku: 'RAD-100', archivedAt: null } as CatalogItem;

it('opens the existing catalogue without treating a review as a product, quote or retry', () => {
  const input = structuredClone(page), selected = resolveAutopilotCatalogueEntry(request, input, workspace, identity, current, 'create');
  expect(selected).toEqual(request); expect(Object.isFrozen(selected)).toBe(true);
  expect(Object.keys(selected!)).toEqual(['organizationId','proposalId','sourceId','origin']);
  expect(input).toEqual(page); expect(Object.isFrozen(selected!.origin)).toBe(true);
});
it.each(['company','workspace','nonce','member','disconnected','unready'])('refuses a stale or unauthorized %s context before navigation', kind => {
  const admitted = { ...identity }, active = { ...current }, loaded = { ...workspace };
  if (kind === 'company') admitted.organizationId = 'company-b';
  if (kind === 'workspace') loaded.workNotesScope = 'workspace-b';
  if (kind === 'nonce') admitted.memberContextNonce = 'b'.repeat(32);
  if (kind === 'member') admitted.memberId = '';
  if (kind === 'disconnected') active.active = false;
  if (kind === 'unready') admitted.ready = false;
  expect(resolveAutopilotCatalogueEntry(request, page, loaded, admitted, active, 'create')).toBeNull();
});
it('permits catalogue consultation but never an item creation for a read-only collaborator', () => {
  expect(resolveAutopilotCatalogueEntry(request,page,workspace,identity,{...current,readOnly:true},'browse')).not.toBeNull();
  expect(resolveAutopilotCatalogueEntry(request,page,workspace,identity,{...current,readOnly:true},'create')).toBeNull();
});
it.each(['other-source','other-proposal','other-company','not-missing','raw-plan','conflicting-duplicate'])('refuses an unrelated or malformed review: %s', kind => {
  const data = structuredClone(page);
  if (kind === 'other-source') data.items[0].sourceId = 'source-b';
  if (kind === 'other-proposal') data.items[0].proposalId = 'proposal-b';
  if (kind === 'other-company') data.organizationId = 'company-b';
  if (kind === 'not-missing') data.items[0].reasons = ['low_confidence'];
  if (kind === 'raw-plan') Object.assign(data.items[0],{plan:{name:'invented',price:1}});
  if (kind === 'conflicting-duplicate') data.items.push({...review,sourceId:'source-b'});
  expect(resolveAutopilotCatalogueEntry(request,data,workspace,identity,current,'create')).toBeNull();
});
it('refuses a switched member nonce at the final ordinary catalogue mutation boundary', () => {
  expect(() => assertAutopilotCatalogueMutationOrigin(request,request.origin)).not.toThrow();
  expect(() => assertAutopilotCatalogueMutationOrigin(request,{...request.origin,memberContextNonce:'b'.repeat(32)})).toThrow();
  expect(() => assertAutopilotCatalogueMutationOrigin(request,{...request.origin,workspaceScope:'workspace-b'})).toThrow();
});
it('matches existing SKU semantics including archived references without changing or restoring an item', () => {
  const rows = [article,{...article,id:'archived',sku:'ARCH-1',archivedAt:'2026-01-01'}];
  expect(autopilotCatalogueSkuExists(' rad-100 ',rows)).toBe(true);
  expect(autopilotCatalogueSkuExists('arch-1',rows)).toBe(true);
  expect(autopilotCatalogueSkuExists('',rows)).toBe(false);
  expect(autopilotCatalogueSkuExists('RAD-100-NEW',rows)).toBe(false);
  expect(rows[1].archivedAt).toBe('2026-01-01');
});
it('offers the manual next step only for the saved item in the original admitted company', () => {
  const followup = {request,catalogItemId:article.id}, loaded = {...workspace,catalogItems:[article]};
  expect(resolveAutopilotCatalogueFollowup(followup,loaded,identity,current)).toBe(followup);
  for(const items of [[],[{...article,archivedAt:'2026-01-01'}],[article,article]])
    expect(resolveAutopilotCatalogueFollowup(followup,{...loaded,catalogItems:items},identity,current)).toBeNull();
  expect(resolveAutopilotCatalogueFollowup(followup,loaded,{...identity,memberContextNonce:'b'.repeat(32)},current)).toBeNull();
  expect(resolveAutopilotCatalogueFollowup(followup,{...loaded,workNotesScope:'workspace-b'},identity,current)).toBeNull();
});
