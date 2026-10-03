import {useEffect,useRef} from 'react';
import type {Workspace} from './types';
import {useFormDraftIdentity} from './useFormDraft';
import {captureWorkspaceMutationOrigin,WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {WorkspaceOriginChangedError} from './workspaceOrigin';
import type {DocumentCreationRequest} from './documentCreationRequest';

/** A pure read is not a mutation action. In particular it remains available
 * when writes are read-only; no app-state, licence-clock or auth read is made. */
export function useDocumentCreationOrigin(workspace:Pick<Workspace,'workNotesScope'>){
 const identity=useFormDraftIdentity();
 const current={companyId:identity.companyId,organizationId:identity.organizationId,memberId:identity.memberId,nonce:identity.memberContextNonce,ready:identity.ready,scope:workspace.workNotesScope};
 const context=useRef({...current,epoch:0}),mounted=useRef(true);
 if(Object.keys(current).some(key=>current[key as keyof typeof current]!==context.current[key as keyof typeof current]))context.current={...current,epoch:context.current.epoch+1};
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 return (request?:DocumentCreationRequest)=>{
  const origin=captureWorkspaceMutationOrigin(workspace,identity),epoch=context.current.epoch;
  if(request&&request.companyId!==origin.workspaceScope)throw new WorkspaceOriginChangedError();
  if(request&&request.memberId!==identity.memberId)throw new WorkspaceMemberOriginChangedError();
  return Object.freeze({origin,memberId:identity.memberId!,assertCurrent:()=>{
   if(!mounted.current||context.current.scope!==origin.workspaceScope||context.current.companyId!==origin.workspaceScope)throw new WorkspaceOriginChangedError();
   if(context.current.epoch!==epoch||context.current.nonce!==origin.memberContextNonce||context.current.memberId!==identity.memberId||context.current.ready!==true)throw new WorkspaceMemberOriginChangedError();
  }});
 };
}
