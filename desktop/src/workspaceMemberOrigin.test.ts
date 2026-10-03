import {describe,expect,it,vi} from 'vitest';
import {WorkspaceOriginChangedError} from './workspaceOrigin';
import {captureWorkspaceMutationOrigin,mutationOriginInvokeArgs,WorkspaceMemberOriginChangedError} from './workspaceMemberOrigin';
import {bindWorkspaceMutationRead,classifyMemberNonceCompatibility,invokeInMemberOrigin,memberOriginNativeFailure} from './memberOriginBridge';
const nonceA='0123456789abcdef0123456789abcdef',nonceB='fedcba9876543210fedcba9876543210';
const admitted={companyId:'company-A',memberId:'member-A',memberContextNonce:nonceA,ready:true};

describe('local member mutation origin',()=>{
  it('captures immutable string values synchronously, without native or authentication reads',()=>{
    const origin=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},admitted);
    expect(Object.isFrozen(origin)).toBe(true);expect(origin).toEqual({workspaceScope:'company-A',memberContextNonce:nonceA});
    const changed={...admitted};const captured=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},changed);changed.memberContextNonce=nonceB;
    expect(captured.memberContextNonce).toBe(nonceA);expect(Object.keys(captured)).toEqual(['workspaceScope','memberContextNonce']);
  });
  it.each(['company-B','',' company-A','company-A\0'])('rejects mismatched or malformed physical space %s before a write',scope=>{
    expect(()=>captureWorkspaceMutationOrigin({workNotesScope:scope},admitted)).toThrow(WorkspaceOriginChangedError);
  });
  it.each([{memberId:''},{ready:false},{memberContextNonce:undefined},{memberContextNonce:'bad'},{memberContextNonce:nonceA.toUpperCase()}])('requires ready verified member context %o',patch=>{
    expect(()=>captureWorkspaceMutationOrigin({workNotesScope:'company-A'},{...admitted,...patch})).toThrow(WorkspaceMemberOriginChangedError);
  });
  it('does not let later B -> A admission replace the original A nonce',()=>{
    const origin=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},admitted);
    const next=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},{...admitted,memberContextNonce:nonceB});
    expect(origin.memberContextNonce).not.toBe(next.memberContextNonce);expect(origin.workspaceScope).toBe(next.workspaceScope);
  });
  it('validates a forwarded physical scope before IPC',()=>{
    const origin=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},admitted);
    expect(()=>mutationOriginInvokeArgs(origin,'company-B')).toThrow(WorkspaceOriginChangedError);
    expect(mutationOriginInvokeArgs(origin,'company-A')).toEqual({expectedWorkspaceScope:'company-A',expectedMemberContextNonce:nonceA});
  });
  it('names the historic missing nonce without giving it an unguarded mutation fallback',()=>{
    expect(classifyMemberNonceCompatibility(undefined)).toBe('legacy-backend-without-member-nonce');
    expect(classifyMemberNonceCompatibility(nonceA)).toBe('guarded-member-origin');
    expect(()=>captureWorkspaceMutationOrigin({workNotesScope:'company-A'},{...admitted,memberContextNonce:undefined})).toThrow(WorkspaceMemberOriginChangedError);
  });
  it('binds the original callback read before await and forwards no newer member',async()=>{
    const source={workspaceScope:'company-A',memberContextNonce:nonceA};
    const load=vi.fn(async(scope:string,nonce:string)=>({workNotesScope:scope,nonce} as never));
    const read=bindWorkspaceMutationRead(source,load);source.workspaceScope='company-B';source.memberContextNonce=nonceB;
    await read();await read();expect(load.mock.calls).toEqual([['company-A',nonceA],['company-A',nonceA]]);
  });
  it('overrides attacker-supplied origin fields with the captured values, using only the supplied IPC',async()=>{
    const invoke=vi.fn(async()=>true),origin=captureWorkspaceMutationOrigin({workNotesScope:'company-A'},admitted);
    await invokeInMemberOrigin(invoke,'create_record',{data:{id:'example'},expectedWorkspaceScope:'company-B',expectedMemberContextNonce:nonceB},origin);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('create_record',{data:{id:'example'},expectedWorkspaceScope:'company-A',expectedMemberContextNonce:nonceA});
  });
  it.each(['Le compte connecté a changé. Rouvrez cette action avec le bon compte.','Le contexte local du compte doit être vérifié. Rouvrez votre espace.'])('makes exact native guard terminal: %s',async message=>{
    expect(memberOriginNativeFailure('Champ invalide : '+message)).toBeInstanceOf(WorkspaceMemberOriginChangedError);
    const read=bindWorkspaceMutationRead(captureWorkspaceMutationOrigin({workNotesScope:'company-A'},admitted),async()=>{throw 'Champ invalide : '+message;});
    await expect(read()).rejects.toThrow(WorkspaceMemberOriginChangedError);
  });
  it('leaves ordinary network errors ordinary instead of ending their recovery',()=>{
    expect(memberOriginNativeFailure('Network request failed')).toBeNull();expect(memberOriginNativeFailure(Error('Network request failed'))).toBeNull();
  });
});

describe('canonical native physical-workspace rejection',()=>{
  const message='L’entreprise ouverte a changé. Rouvrez cette action dans le bon espace.';
  it.each([message,'Champ invalide : '+message,Error(message),Error('Champ invalide : '+message)])('keeps exact native physical refusal terminal: %s',reason=>{
    const failure=memberOriginNativeFailure(reason);expect(failure).toBeInstanceOf(WorkspaceOriginChangedError);expect(failure).not.toBeInstanceOf(WorkspaceMemberOriginChangedError);
  });
  it('keeps bound read and invocation refusals terminal without replacing their original origin',async()=>{
    const origin={workspaceScope:'company-A',memberContextNonce:nonceA};
    const load=vi.fn(async()=>{throw Error('Champ invalide : '+message);});
    const read=bindWorkspaceMutationRead(origin,load);await expect(read()).rejects.toThrow(WorkspaceOriginChangedError);
    expect(load).toHaveBeenCalledExactlyOnceWith('company-A',nonceA);
    const invoke=vi.fn(async()=>{throw 'Champ invalide : '+message;});
    await expect(invokeInMemberOrigin(invoke,'create_record',{data:{id:'test'}},origin)).rejects.toThrow(WorkspaceOriginChangedError);expect(invoke).toHaveBeenCalledTimes(1);
  });
  it.each([message+' Server detail.','Network unavailable: '+message])('does not infer a physical transition from partial or embedded text: %s',reason=>{
    expect(memberOriginNativeFailure(reason)).toBeNull();
  });
});
