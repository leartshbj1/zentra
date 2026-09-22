'use client';
import { useEffect, useState } from 'react';
import type { appointmentState } from '@/lib/appointments/service';
type State = Awaited<ReturnType<typeof appointmentState>>;
const labels: Record<string,string> = { imported:'Ajouté à l’agenda',pending:'À vérifier dans Gestion',review:'À vérifier dans Gestion',claimed:'En cours dans Gestion',failed:'À reprendre dans Gestion',ignored:'Écarté' };
export function AppointmentReceipts({organizationId}:{organizationId:string}) {
  const [data,setData]=useState<State|null>(null),[error,setError]=useState(''),[attempt,setAttempt]=useState(0);
  useEffect(()=>{
    let active=true,running=false;const controller=new AbortController();
    const load=async()=>{
      if(running||document.visibilityState==='hidden')return;running=true;
      try {
        const res=await fetch('/api/appointments?organizationId='+encodeURIComponent(organizationId),{cache:'no-store',signal:controller.signal});
        const next=await res.json() as State;
        if(!res.ok||next.organizationId!==organizationId)throw Error();
        if(active){setData(next);setError('');}
      } catch {if(active)setError('Les rendez-vous ne sont pas disponibles pour le moment.');}
      finally{running=false;}
    };
    void load();const timer=setInterval(()=>void load(),30000);
    document.addEventListener('visibilitychange',load);
    return ()=>{active=false;controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',load);};
  },[organizationId,attempt]);
  return <section className="automation-appointment-receipts">
    <h2>Rendez-vous reçus</h2><p>Retrouvez leur état dans l’agenda partagé. Les éléments incomplets se corrigent dans Gestion → Automation → Rendez-vous.</p>
    {error&&<p role="alert">{error} <button type="button" onClick={()=>setAttempt(v=>v+1)}>Réessayer</button></p>}
    {!data&&!error&&<p role="status">Chargement des rendez-vous…</p>}
    {data&&!data.items.length&&<p>Aucun rendez-vous reçu pour le moment.</p>}
    {data?.items.map(item=><details key={item.id}><summary><span><strong>{item.extraction.title||item.subject}</strong><small>{item.extraction.startDate} {item.extraction.allDay?'Toute la journée':item.extraction.startTime}</small></span><span>{labels[item.state]||'À vérifier dans Gestion'}</span></summary><p>{item.extraction.location||'Lieu non précisé'}</p><p className="ac-preserve">{item.extraction.notes}</p></details>)}
  </section>;
}
