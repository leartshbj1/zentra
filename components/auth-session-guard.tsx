'use client';
import { useEffect } from 'react';
import { AUTH_CHANGED_EVENT } from '@/lib/auth-browser-events';

export function AuthSessionGuard() {
  useEffect(() => {
    let pending=false;
    const controller=new AbortController();
    async function checkSession(){
      if(pending || document.visibilityState!=='visible' || !/^\/(compte|support\/espace)(\/|$)/.test(window.location.pathname))return;
      pending=true;
      try{
        const response=await fetch('/api/auth/session',{credentials:'same-origin',cache:'no-store',signal:controller.signal});
        if(!response.ok)return; // A temporary network failure is not a logout.
        const session=await response.json() as {authenticated?:boolean};
        if(!controller.signal.aborted && session.authenticated===false){
          const target=window.location.pathname+window.location.search;
          window.location.replace(`/connexion?retour=${encodeURIComponent(target)}`);
        }
      }catch{/* Retry on the next foreground check. */}finally{pending=false;}
    }
    const visible=()=>{if(document.visibilityState==='visible')void checkSession();};
    const interval=window.setInterval(()=>void checkSession(),240000);
    const refresh = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGED_EVENT) window.location.reload();
    };
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener('storage', refresh);
    window.addEventListener('pageshow', restored);
    document.addEventListener('visibilitychange',visible);
    return () => {
      window.removeEventListener('storage', refresh);
      window.removeEventListener('pageshow', restored);
      document.removeEventListener('visibilitychange',visible);
      window.clearInterval(interval);controller.abort();
    };
  }, []);
  return null;
}
