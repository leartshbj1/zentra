import type { AccountWorkspace } from './account-workspaces';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function accountWorkspaceDestination(workspace:Pick<AccountWorkspace,'organizationId'|'edition'>):string {
  if(workspace.edition==='us_experimental') {
    if(!uuid.test(workspace.organizationId)) throw new Error('Invalid workspace destination');
    return `/compte/espaces/us/${workspace.organizationId}`;
  }
  if(workspace.edition!=='ch_legacy' || !workspace.organizationId || workspace.organizationId.length>200) throw new Error('Invalid workspace destination');
  return `/compte/entreprise?organizationId=${encodeURIComponent(workspace.organizationId)}`;
}
/** A malformed US path never falls back into Swiss settings. */
export function accountUsNavigation(pathname:string):{isUs:boolean;destination:string|null} {
  if(pathname==='/compte/espaces/us')return {isUs:true,destination:null};
  if(!pathname.startsWith('/compte/espaces/us/')) return {isUs:false,destination:null};
  const id=pathname.slice('/compte/espaces/us/'.length).replace(/\/$/,'');
  return {isUs:true,destination:uuid.test(id)?`/compte/espaces/us/${id}`:null};
}
