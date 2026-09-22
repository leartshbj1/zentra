/** Resolve deep links only among the current user's workspaces; never fall back to another company. */
export function selectSupportWorkspace<T extends {id:string}>(accessible:T[],workspaceId:string|null,organizationId:string|null,links:{workspace_id:string}[]):T|undefined {
  if(workspaceId)return accessible.find(w=>w.id===workspaceId&&(!organizationId||links.some(link=>link.workspace_id===w.id)));
  return organizationId?accessible.find(w=>links.some(link=>link.workspace_id===w.id)):accessible[0];
}
