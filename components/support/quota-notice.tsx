/* oxlint-disable jsx-a11y/prefer-tag-over-role -- This block notification groups an icon, explanation and link. */
import type { SupportBillingState } from '@/lib/support/plans';
export function SupportQuotaNotice({billing,href='/compte/abonnement'}:{billing?:SupportBillingState;href?:string}){
  if(!billing?.active||billing.limit<=0||billing.ownerAccess||billing.used/billing.limit<.8)return null;
  const remaining=Math.max(0,billing.limit-billing.used);
  return <div className="support-notice" role="status"><span>{remaining?`Il reste ${remaining.toLocaleString('fr-CH')} analyses pour cette période.`:'Quota atteint : les nouvelles analyses sont en attente.'} Aucun supplément automatique.</span><a href={href}>Voir mon abonnement</a></div>;
}
