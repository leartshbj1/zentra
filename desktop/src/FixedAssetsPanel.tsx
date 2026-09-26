import { useEffect, useRef, useState } from 'react';
import { Plus, Archive, ArrowDownToLine } from 'lucide-react';
import { fixedAssetsApi, assetPresets, type FixedAsset, type FixedAssetRow } from './fixedAssets';
import type { Account, Workspace } from './types';
import { desktopApi } from './bridge';
import { createId, errorMessage, formatMoney, todayIso } from './utils';
import { purchaseDecimal } from './supplierInvoicePreparation';
import { Button, ErrorPanel, Field, EmptyState, submitForm } from './ui';
import './fixed-assets.css';

export function FixedAssetsPanel({workspace,readOnly,onChanged,onSetup}:{workspace:Workspace;readOnly:boolean;onChanged:()=>Promise<unknown>;onSetup:()=>void}){
  const [items,setItems]=useState<FixedAssetRow[]>([]), [accounts,setAccounts]=useState(workspace.accounts);
  const [busy,setBusy]=useState(false), [error,setError]=useState(''), [editing,setEditing]=useState(false), [loaded,setLoaded]=useState(false);
  const [draft,setDraft]=useState<FixedAsset>(()=>blank()), [cost,setCost]=useState(''), [residual,setResidual]=useState('0'),[rate,setRate]=useState('20'),[confirmed,setConfirmed]=useState(false);
  const [review,setReview]=useState<{kind:'depreciate'|'cancel';row:FixedAssetRow}|null>(null);
  const running=useRef(false), generation=useRef(0),heading=useRef<HTMLHeadingElement>(null);
  function blank():FixedAsset{return {id:createId(),name:'',reference:'',date:todayIso(),costCents:0,residualCents:0,rateBp:2000,method:'linear',mode:'reclassify',assetAccountId:'',depreciationAccountId:'',counterpartAccountId:''};}
  useEffect(()=>{const ticket=++generation.current;void fixedAssetsApi.list().then(value=>{if(ticket===generation.current){setItems(value.items);setLoaded(true);}}).catch(reason=>{if(ticket===generation.current)setError(errorMessage(reason,'Le registre n’a pas pu être chargé.'));});return()=>{generation.current++;};},[workspace]);
  useEffect(()=>{setAccounts(workspace.accounts);},[workspace.accounts]);
  async function run(action:()=>Promise<{items:FixedAssetRow[]}>){
    if(running.current||readOnly)return;running.current=true;setBusy(true);setError('');
    try{const result=await action();setItems(result.items);setLoaded(true);setEditing(false);setReview(null);try{await onChanged();}catch{setError('L’écriture est enregistrée. Fermez puis rouvrez la comptabilité pour actualiser les autres écrans.');}}
    catch(reason){setError(errorMessage(reason,'L’opération n’a pas abouti. Votre saisie est conservée.'));}
    finally{running.current=false;setBusy(false);}
  }
  const assets=accounts.filter(a=>a.active&&a.reportSection==='fixed_assets'&&a.accountType==='asset');
  const depreciation=accounts.filter(a=>a.active&&a.reportSection==='depreciation'&&a.accountType==='expense');
  const counterparts=accounts.filter(a=>a.active&&(draft.mode==='purchase'?a.id===workspace.accountingSettings?.bankAccountId:a.accountType==='expense'&&a.reportSection!=='depreciation'));
  const enabled=Boolean(workspace.accountingSettings?.enabled);
  function start(){setDraft({...blank(),assetAccountId:assets[0]?.id||'',depreciationAccountId:depreciation[0]?.id||'',counterpartAccountId:workspace.accountingSettings?.expenseAccountId||''});setCost('');setResidual('0');setRate('20');setConfirmed(false);setEditing(true);setReview(null);setError('');requestAnimationFrame(()=>heading.current?.focus());}
  function update<K extends keyof FixedAsset>(key:K,value:FixedAsset[K]){setDraft(previous=>({...previous,[key]:value}));setConfirmed(false);}
  async function prepareAccounts(){
    if(running.current||readOnly)return;running.current=true;setBusy(true);setError('');
    try{
      const latest=await desktopApi.listAccounts();
      for(const specification of [{code:'1500',name:'Immobilisations corporelles',accountType:'asset',reportSection:'fixed_assets'},{code:'6800',name:'Amortissements',accountType:'expense',reportSection:'depreciation'}] as const){
        if(latest.some(a=>a.active&&a.reportSection===specification.reportSection&&a.accountType===specification.accountType))continue;
        if(latest.some(a=>a.code===specification.code))throw Error(`Le compte ${specification.code} existe avec un autre usage. Choisissez un compte dans Plan et liaisons.`);
        await desktopApi.upsertAccount({...specification,normalBalance:'debit',active:true});
      }
      const refreshed=await desktopApi.listAccounts();setAccounts(refreshed);setDraft(value=>({...value,assetAccountId:refreshed.find(a=>a.active&&a.reportSection==='fixed_assets')?.id||'',depreciationAccountId:refreshed.find(a=>a.active&&a.reportSection==='depreciation')?.id||''}));await onChanged();
    }catch(reason){setError(errorMessage(reason,'Les comptes n’ont pas pu être préparés.'));}finally{running.current=false;setBusy(false);}
  }
  const picker=(label:string,key:'assetAccountId'|'depreciationAccountId'|'counterpartAccountId',options:Account[])=><Field label={label} required><select required value={draft[key]} onChange={e=>update(key,e.target.value)}><option value="">Choisir un compte</option>{options.map(a=><option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}</select></Field>;
  const active=items.filter(row=>!row.cancelled);
  return <section className="panel fixed-assets">
    <header className="fixed-assets__header"><div><h2>Immobilisations</h2><p>Vos équipements, leur valeur et leurs amortissements.</p></div><Button type="button" disabled={busy||readOnly||!enabled||editing} onClick={start}><Plus size={18}/>Ajouter un bien</Button></header>
    {!enabled&&<div className="report-callout"><p>Configurez d’abord les comptes de votre entreprise.</p><Button type="button" variant="secondary" onClick={onSetup}>Ouvrir Plan et liaisons</Button></div>}
    {error&&<ErrorPanel title="Vérifions ce point" message={error}/>}
    {editing&&<form className="fixed-assets__form" onSubmit={submitForm(async()=>{
      const costCents=purchaseDecimal(cost,2,1e9),residualCents=purchaseDecimal(residual,2,1e9),rateBp=purchaseDecimal(rate,2,10000);
      if(costCents===null||residualCents===null||rateBp===null){setError('Indiquez des montants et un taux valides.');return;}
      if(!confirmed){setError('Confirmez l’origine de cet achat avant de l’enregistrer.');return;}
      await run(()=>fixedAssetsApi.register({...draft,costCents,residualCents,rateBp}));
    })}>
      <h3 ref={heading} tabIndex={-1}>Enregistrer un bien</h3>
      <fieldset disabled={busy||readOnly}>
        <div className="form-grid"><Field label="Nom du bien" required><input required maxLength={160} value={draft.name} placeholder="MacBook de l’entreprise" onChange={e=>update('name',e.target.value)}/></Field><Field label="Référence d’achat" required><input required maxLength={200} value={draft.reference} placeholder="Numéro de la facture" onChange={e=>update('reference',e.target.value)}/></Field><Field label="Date d’acquisition" required><input type="date" required max={todayIso()} value={draft.date} onChange={e=>update('date',e.target.value)}/></Field><Field label="Coût à immobiliser, CHF" required hint="Hors TVA récupérable ; TVA non récupérable incluse."><input inputMode="decimal" required value={cost} onChange={e=>{setCost(e.target.value);setConfirmed(false);}}/></Field></div>
        <Field label="Cet achat est-il déjà dans votre comptabilité ?"><select value={draft.mode} onChange={e=>{update('mode',e.target.value as FixedAsset['mode']);update('counterpartAccountId',e.target.value==='purchase'?workspace.accountingSettings?.bankAccountId||'':workspace.accountingSettings?.expenseAccountId||'');}}><option value="reclassify">Oui, reclasser cet achat</option><option value="purchase">Non, achat bancaire sans TVA</option></select></Field>
        <p className="fixed-assets__hint">Pour une facture avec TVA, enregistrez d’abord l’achat dans Achats et fournisseurs, puis reclassez son coût ici. Aucune TVA n’est déduite une seconde fois.</p>
        {(!assets.length||!depreciation.length)&&<Button type="button" variant="secondary" onClick={()=>void prepareAccounts()}>Ajouter les comptes nécessaires</Button>}
        <div className="form-grid">{picker('Compte d’immobilisation','assetAccountId',assets)}{picker(draft.mode==='purchase'?'Compte bancaire':'Charge déjà comptabilisée','counterpartAccountId',counterparts)}</div>
        <details className="fixed-assets__policy" open><summary>Amortissement</summary><div className="form-grid"><Field label="Type de bien"><select defaultValue="computer" onChange={e=>{const preset=assetPresets.find(p=>p.id===e.target.value)!;setRate(String(preset.declining/(draft.method==='linear'?200:100)));setConfirmed(false);}}>{assetPresets.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></Field><Field label="Méthode"><select value={draft.method} onChange={e=>{const next=e.target.value as FixedAsset['method'];const n=Number(rate.replace(',','.'));setRate(String(next==='linear'?n/2:Math.min(100,n*2)));update('method',next);}}><option value="linear">Linéaire</option><option value="declining">Dégressif</option></select></Field><Field label="Taux annuel, %" required><input inputMode="decimal" required value={rate} onChange={e=>{setRate(e.target.value);setConfirmed(false);}}/></Field><Field label="Valeur résiduelle, CHF"><input inputMode="decimal" value={residual} onChange={e=>{setResidual(e.target.value);setConfirmed(false);}}/></Field>{picker('Charge d’amortissement','depreciationAccountId',depreciation)}</div><p className="fixed-assets__hint">Taux indicatifs AFC, modifiables selon le bien et votre canton. Première année au prorata des jours. Les terrains ne sont pas pris en charge ici.</p></details>
        <label className="fixed-assets__confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>{draft.mode==='reclassify'?'Je confirme que ce coût est déjà enregistré dans la charge choisie.':'Je confirme que cet achat sans TVA n’a pas encore été comptabilisé.'}</span></label>
        <div className="fixed-assets__actions"><Button type="button" variant="ghost" onClick={()=>setEditing(false)}>Annuler</Button><Button type="submit" disabled={!confirmed||!assets.length||!depreciation.length}>{busy?'Enregistrement…':'Enregistrer le bien'}</Button></div>
      </fieldset>
    </form>}
    {!loaded&&!error?<p role="status">Ouverture du registre…</p>:!active.length&&!editing?<EmptyState icon={<Archive/>} title="Votre registre est prêt" text="Ajoutez le matériel durable de votre entreprise pour suivre sa valeur dans le bilan."/>:<div className="fixed-assets__list">{active.map(row=><article key={row.asset.id}><div className="fixed-assets__identity"><h3>{row.asset.name}</h3><p>{row.asset.reference} · acquis le {row.asset.date}</p></div><dl><div><dt>Acquisition</dt><dd>{formatMoney(row.asset.costCents)}</dd></div><div><dt>Amorti</dt><dd>{formatMoney(row.depreciatedCents)}</dd></div><div><dt>Valeur comptable</dt><dd>{formatMoney(row.bookValueCents)}</dd></div></dl>{row.blocker?<p role="alert">{row.blocker}</p>:<div className="fixed-assets__actions">{!row.history.length&&<Button type="button" variant="ghost" disabled={busy||readOnly||editing} onClick={()=>setReview({kind:'cancel',row})}>Annuler le bien</Button>}{row.nextAmountCents>0&&<Button type="button" variant="secondary" disabled={busy||readOnly||editing} onClick={()=>setReview({kind:'depreciate',row})}><ArrowDownToLine size={16}/>Amortissement {row.nextYear}</Button>}</div>}{review?.row.asset.id===row.asset.id&&<div className="fixed-assets__review" role="group" aria-label="Confirmer l’écriture"><p>{review.kind==='depreciate'?`Comptabiliser ${formatMoney(row.nextAmountCents)} au 31.12.${row.nextYear} ?`:'Annuler l’immobilisation à la date d’aujourd’hui et rétablir son compte d’origine ?'}</p><div className="fixed-assets__actions"><Button type="button" variant="ghost" disabled={busy} onClick={()=>setReview(null)}>Retour</Button><Button type="button" disabled={busy||readOnly} onClick={()=>void run(()=>review.kind==='depreciate'?fixedAssetsApi.depreciate(row):fixedAssetsApi.cancel(row.asset.id,todayIso()))}>Confirmer l’écriture</Button></div></div>}{row.history.length>0&&<details><summary>Historique des amortissements</summary>{row.history.map(h=><p key={h.id}>{h.entry_date} · {formatMoney(h.amount_cents)}</p>)}</details>}</article>)}</div>}
    {items.some(row=>row.cancelled)&&<details className="fixed-assets__cancelled"><summary>Biens annulés</summary>{items.filter(row=>row.cancelled).map(row=><p key={row.asset.id}>{row.asset.name} · {row.asset.reference}</p>)}</details>}
  </section>;
}
