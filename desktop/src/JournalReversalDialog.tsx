import { useEffect, useRef, useState } from 'react';
import type { JournalEntry } from './types';
import { Button, Field, Modal } from './ui';
import { errorMessage, formatDate, todayIso } from './utils';
import './JournalReversalDialog.css';

export function JournalReversalDialog({entry,busy,onClose,onConfirm}:{entry:JournalEntry;busy:boolean;onClose:()=>void;onConfirm:(date:string,description:string)=>Promise<void>}) {
  const restoring=entry.reversalAction==='restore_expense';
  const [error,setError]=useState('');
  const submitting=useRef(false);
  const [saving,setSaving]=useState(false);
  const errorRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{if(error){errorRef.current?.focus({preventScroll:true});errorRef.current?.scrollIntoView({block:'nearest'});}},[error]);
  return <Modal title={restoring?'Rétablir la dépense':'Extourner une écriture'} description={restoring?'Corrigez une ancienne extourne enregistrée par erreur.':'Conservez l’original et créez une écriture inverse datée.'} onClose={onClose} dismissible={!busy&&!saving}>
    <form className="journal-reversal-dialog" onSubmit={async(event)=>{
      event.preventDefault(); if(busy||submitting.current)return;
      const form=new FormData(event.currentTarget);
      submitting.current=true;setSaving(true);setError('');
      try{await onConfirm(String(form.get('entryDate')),String(form.get('description')));}
      catch(cause){setError(errorMessage(cause,'La correction a été refusée. Vos champs sont conservés.'));}
      finally{submitting.current=false;setSaving(false);}
    }}>
      <div className="info-strip"><span><strong>{entry.number} · {formatDate(entry.entryDate)}</strong><br/>{entry.description}</span></div>
      {restoring?<p>Cette correction rétablit l’effet comptable de la dépense déjà payée. L’achat et son justificatif restent conservés. Aucun nouveau paiement bancaire n’est envoyé.</p>:null}
      <Field label="Date de correction" required><input name="entryDate" type="date" min={entry.entryDate} defaultValue={todayIso()<entry.entryDate?entry.entryDate:todayIso()} required disabled={busy||saving}/></Field>
      <Field label="Motif" required={restoring}><textarea name="description" rows={3} maxLength={500} required={restoring} defaultValue={restoring?'':`Extourne ${entry.number}`} placeholder={restoring?'Expliquez pourquoi la dépense doit être rétablie':''} disabled={busy||saving}/></Field>
      {error?<p className="journal-reversal-dialog__error" role="alert" tabIndex={-1} ref={errorRef}>{error}</p>:null}
      <div className="form-actions"><Button type="button" variant="secondary" disabled={busy||saving} onClick={onClose}>Fermer</Button><Button type="submit" disabled={busy||saving}>{saving?'Enregistrement…':restoring?'Rétablir la dépense':'Créer l’extourne'}</Button></div>
    </form>
  </Modal>;
}
