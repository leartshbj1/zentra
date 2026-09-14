import { useEffect, useRef, useState } from 'react';
import { Check, Copy, RefreshCw, Users } from 'lucide-react';
import { desktopApi } from './bridge';
import type { AppSettings } from './types';
import { t } from './language';
import { Button, ErrorPanel, Field } from './ui';
import { errorMessage } from './utils';
import './cloudTeam.css';

export type CloudTeam = {organizationId:string;organizationName:string;role:string;canManage:boolean;profile:Record<string,unknown>|null;companyCopy?:{backupId:string;publishedAt:string;sizeBytes:number}|null;seats:{planName:string;limit:number|null;used:number;reserved:number;available:number|null;subscriptionActive:boolean};members:{id:string;email:string;role:string}[];invitations:{id:string;email:string;role:string;expiresAt:number}[]};
const roles = [ ['member','Collaborateur','Travaille dans l’application, sans gérer les accès.'], ['admin','Administrateur','Travaille dans l’application et gère les accès.'], ['accountant','Comptable / fiduciaire','Consulte et travaille sur les données, sans gérer les accès.'], ['read_only','Lecture seule','Consulte et exporte, sans modifier les données.'] ];
export function CloudTeamPanel({settings}: {settings?:AppSettings|null}) {
  const [team,setTeam]=useState<CloudTeam|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[email,setEmail]=useState(''),[role,setRole]=useState('member'),[link,setLink]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef(false);
  const [shareFull,setShareFull]=useState(false),[stage,setStage]=useState('');
  async function shareCompany() {
    if(settings) await desktopApi.publishCloudCompany(settings);
    setStage('Envoi de l’entreprise et des documents…');
    await desktopApi.publishCompanyCopy();
    setStage('');
  }
  async function reload() { setTeam(await desktopApi.getCloudTeam()); }
  useEffect(()=>{let active=true;desktopApi.getCloudTeam().then(value=>{if(active)setTeam(value);}).catch(reason=>{if(active)setError(errorMessage(reason,'La liste des accès n’a pas pu être chargée. Réessayez.'));});return()=>{active=false;};},[]);
  async function run(action:()=>Promise<unknown>, refresh=true) { if(pending.current)return;pending.current=true;setBusy(true);setError('');setNotice('');try{await action();if(refresh)await reload();}catch(reason){setError(errorMessage(reason,'L’action n’a pas abouti. Actualisez pour vérifier son résultat.'));}finally{pending.current=false;setBusy(false);} }
  const full=team?.seats.available===0 || !team?.seats.subscriptionActive;
  return <section className="cloud-team" aria-label={t('Équipe et invitations')}>
    <header><Users size={22}/><div><h3>{t('Équipe et invitations')}</h3><p>{team ? `${team.seats.planName} · ${team.seats.used}${team.seats.limit===null?'':` / ${team.seats.limit}`} ${t('personnes, titulaire compris')}` : t('Chargement des accès…')}</p></div><Button size="icon" variant="ghost" disabled={busy} aria-label={t('Actualiser les accès')} onClick={()=>void run(reload,false)}><RefreshCw size={18}/></Button></header>
    {error && <ErrorPanel message={error}/>}
    {notice && <p role="status">{t(notice)}</p>}
    {team?.canManage && <>
      {settings && <div className="cloud-team__profile"><div><strong>{t('Toute l’entreprise sur le nouvel appareil')}</strong><p>{t('Clients, devis, factures, projets, comptabilité, salaires et pièces jointes : les membres autorisés reçoivent la copie complète au moment de rejoindre.')}</p><p>{t('Les modifications métier suivantes restent locales. Seuls les documents des projets se synchronisent ensuite automatiquement.')}</p><label className="cloud-team__consent"><input type="checkbox" checked={shareFull} disabled={busy} onChange={event=>setShareFull(event.target.checked)}/><span>{t('Je partage la base complète, y compris les salaires, avec les membres autorisés de cette entreprise.')}</span></label></div><Button variant="secondary" disabled={busy||!shareFull} onClick={()=>void run(async()=>{await shareCompany();setNotice('La copie complète est prête pour les appareils invités.');}).finally(()=>setStage(''))}>{t(team.companyCopy?'Actualiser la copie partagée':'Partager l’entreprise complète')}</Button></div>}
      {team.seats.reserved>0 && <p>{t('{count} invitation(s) en attente réservent une place.',{count:team.seats.reserved})}</p>}
      <form onSubmit={event=>{event.preventDefault();void run(async()=>{if(!team.companyCopy&&!shareFull)throw new Error('Partagez d’abord une copie complète de l’entreprise.');if(shareFull)await shareCompany();setStage('Création du lien…');const result=await desktopApi.inviteCloudMember(email.trim(),role);setLink(result.invitation.url);setNotice('Invitation créée. Transmettez le lien à cette personne.');}).finally(()=>setStage(''));}}>
        <Field label={t('Adresse e-mail')} required><input aria-label={t('Adresse e-mail')} type="email" required autoComplete="email" value={email} disabled={busy||full} onChange={event=>{setEmail(event.target.value);setLink('');}}/></Field>
        <Field label={t('Rôle')}><select aria-label={t('Rôle')} value={role} disabled={busy||full} onChange={event=>{setRole(event.target.value);setLink('');}}>{roles.map(([value,label])=><option key={value} value={value}>{t(label)}</option>)}</select></Field>
        <p className="cloud-team__role">{t(roles.find(([value])=>value===role)![2])}</p>
        {full && <p role="status">{t('Toutes les places sont utilisées ou l’abonnement doit être renouvelé. Gérez les accès ou la formule dans votre compte.')}</p>}
        {busy && stage && <p role="status">{t(stage)}</p>}
        {!team.companyCopy&&!shareFull&&<p>{t('Cochez le partage de l’entreprise complète ci-dessus pour préparer l’invitation.')}</p>}
        <Button type="submit" disabled={busy||full||(!team.companyCopy&&!shareFull)}>{t(busy?'Préparation…':'Créer le lien d’invitation')}</Button>
      </form>
      {link && <div className="cloud-team__link"><label>{t('Lien réservé à l’adresse invitée')}<input readOnly value={link} onFocus={event=>event.currentTarget.select()}/></label><Button variant="secondary" onClick={()=>void navigator.clipboard.writeText(link).then(()=>setNotice('Lien copié.')).catch(()=>setError(t('Sélectionnez le lien pour le copier manuellement.')))}><Copy size={17}/>{t('Copier le lien')}</Button></div>}
      <ul className="cloud-team__people">{team.members.map(person=><li key={person.id}><Check size={16}/><span>{person.email}<small>{t(person.role==='owner'?'Propriétaire':roles.find(([value])=>value===person.role)?.[1]||person.role)}</small></span></li>)}{team.invitations.map(invitation=><li key={invitation.id}><span>{invitation.email}<small>{t('Invitation en attente')} · {t(roles.find(([value])=>value===invitation.role)?.[1]||invitation.role)}</small></span><Button variant="ghost" disabled={busy} onClick={()=>void run(()=>desktopApi.revokeCloudInvitation(invitation.id))}>{t('Annuler l’invitation')}</Button></li>)}</ul>
    </>}
    {team && !team.canManage && <p>{t('Le titulaire ou un administrateur gère les invitations. Votre rôle est affiché dans votre connexion.')}</p>}
  </section>;
}
