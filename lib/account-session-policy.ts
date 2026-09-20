import { database } from '@/lib/runtime';
/** Read only after Supabase has verified this bearer token. No claims authorize an identity here. */
export async function accountSessionAllowed(userId:string, verifiedAccessToken:string){
  const policy=await database().prepare('SELECT revoked_before,deleted_at FROM account_session_policy WHERE user_id=?').bind(userId).first<{revoked_before:number;deleted_at:number|null}>();
  if(!policy)return true;
  if(policy.deleted_at)return false;
  try {
    const claims=JSON.parse(atob(verifiedAccessToken.split('.')[1].replaceAll('-','+').replaceAll('_','/')));
    return claims.sub===userId && Number.isSafeInteger(claims.iat) && claims.iat>policy.revoked_before;
  }catch{return false;}
}
export async function revokeAccountSessions(userId:string){
  const now=Math.floor(Date.now()/1000);
  await database().batch([
    database().prepare('INSERT INTO account_session_policy(user_id,revoked_before)VALUES(?,?) ON CONFLICT(user_id)DO UPDATE SET revoked_before=MAX(revoked_before,excluded.revoked_before)').bind(userId,now),
    database().prepare('UPDATE device_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').bind(now,userId),
  ]);
}
