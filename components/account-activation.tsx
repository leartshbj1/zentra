'use client';

import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

export function AccountActivation({ sessionId }: { sessionId: string }) {
  const [company,setCompany]=useState('');
  const [error,setError]=useState('');
  const [loginRequired,setLoginRequired]=useState(false);
  const [attempt,setAttempt]=useState(0);
  const [busy,setBusy]=useState(true);
  useEffect(()=>{
    const controller=new AbortController(); let timer:ReturnType<typeof setTimeout>;
    setBusy(true);setError('');setLoginRequired(false);
    async function activate(retry=0) {
      try {
        const response=await fetch('/api/account/claim',{
          method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({sessionId}),signal:controller.signal,
        });
        const body=await response.json() as {organization?:{id?:string;name?:string};error?:string};
        if(controller.signal.aborted)return;
        if(response.ok && body.organization?.id){setCompany(body.organization.name || 'Votre entreprise');setBusy(false);return;}
        if((response.status===402 || response.status===503) && retry<4){timer=setTimeout(()=>void activate(retry+1),3000);return;}
        setLoginRequired(response.status===401);
        throw new Error(body.error || 'La confirmation du paiement est encore en attente.');
      } catch(reason) {
        if(controller.signal.aborted)return;
        setError(reason instanceof Error?reason.message:'Vérifiez votre connexion, puis réessayez.');setBusy(false);
      }
    }
    void activate();
    return()=>{controller.abort();clearTimeout(timer);};
  },[sessionId,attempt]);
  const returnTo=`/paiement/succes?session_id=${encodeURIComponent(sessionId)}`;
  return <section className="rounded-3xl border border-[#e5e5e9] bg-white p-6 shadow-sm sm:p-9" aria-live="polite">
    {busy?<><LoaderCircle className="size-7 animate-spin text-[#315d47]"/><h2 className="mt-4 text-xl font-semibold">Confirmation de votre abonnement…</h2><p className="mt-2 text-sm leading-6 text-[#5f6962]">Votre accès s’active automatiquement après la confirmation du paiement.</p></>:company?<>
      <CheckCircle2 className="size-8 text-[#315d47]"/>
      <h2 className="mt-4 text-2xl font-semibold">Votre abonnement est actif</h2>
      <p className="mt-2 text-[#5f6962]">{company}</p>
      <ol className="mt-6 list-decimal space-y-3 pl-5 text-base leading-7"><li>Ouvrez l’application Zentra.</li><li>Choisissez « Se connecter » avec le compte utilisé pour cet achat.</li><li>Confirmez votre appareil. Votre licence s’active automatiquement.</li></ol>
      <div className="mt-7 flex flex-wrap gap-3"><a href="/download" className="inline-flex min-h-12 items-center rounded-full bg-[#173d2c] px-6 font-semibold text-white">Télécharger Zentra</a><a href="/compte" className="inline-flex min-h-12 items-center rounded-full border border-[#d9dedb] px-6 font-semibold">Mon compte</a></div>
    </>:<>
      <h2 className="text-xl font-semibold">{loginRequired?'Retrouvez votre abonnement':'Le paiement doit encore être confirmé'}</h2>
      <p className="mt-3 text-sm leading-6 text-[#7b3e31]" role="alert">{error}</p>
      {loginRequired?<a className="mt-5 inline-flex min-h-12 items-center rounded-full bg-[#173d2c] px-6 font-semibold text-white" href={`/connexion?retour=${encodeURIComponent(returnTo)}`}>Se connecter à Zentra</a>:<button className="mt-5 min-h-12 rounded-full bg-[#173d2c] px-6 font-semibold text-white" onClick={()=>setAttempt(value=>value+1)}>Vérifier à nouveau</button>}
      <p className="mt-4 text-sm text-[#5f6962]">Ne repassez pas commande : cette page vérifie le paiement existant.</p>
    </>}
  </section>;
}
