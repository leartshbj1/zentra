import { useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SubscriptionOverview } from './subscription-overview';
import { desktopApi } from './bridge';
export function NativeSubscription({organizationId}:{organizationId:string}){
  const [error,setError]=useState('');
  const request=useCallback(()=>invoke<Record<string,unknown>>('subscription_overview_request'),[]);
  return <>{error&&<p role="alert">{error}</p>}<SubscriptionOverview organizationId={organizationId} native request={request} onOpen={url=>{
    const path=new URL(url,'https://zentraapp.ch').pathname;
    const section=path==='/compte/equipe'?'equipe':path==='/compte/automation'?'automation':path==='/compte/entreprise'?'entreprise':'abonnement';
    setError('');
    const opening=path==='/support/espace'?invoke('open_supplier_inbox_settings',{section:'connections'}):desktopApi.openCloudAccountPortal(section);
    void opening.catch(()=>setError('Impossible d’ouvrir votre compte. Vérifiez la connexion puis réessayez.'));
  }}/></>;
}
