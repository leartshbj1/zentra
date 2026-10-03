import { createContext, useContext, useEffect, useRef, useState, type ReactNode, type SetStateAction } from 'react';
import { getAppLanguage, useAppLanguage } from './language';
import { Button } from './ui';
import type { Workspace } from './types';
import { FormDraftSession, type FormDraftOptions } from './formDrafts';
import { formDraftTranslations } from './translationsFormDrafts';
import './form-drafts.css';

type Identity = { companyId?: string; organizationId?: string; memberId?: string; ready?: boolean };
const FormDraftIdentity = createContext<Identity>({});
export function FormDraftIdentityProvider({ children, ...identity }: Identity & { children: ReactNode }) { return <FormDraftIdentity.Provider value={identity}>{children}</FormDraftIdentity.Provider>; }
export function useFormDraftScope(workspace: Pick<Workspace, 'workNotesScope'> | undefined, type: string, recordId?: string, context?: string) {
  const identity = useContext(FormDraftIdentity);
  const companyId = workspace?.workNotesScope || identity.companyId;
  return companyId && identity.ready !== false ? { companyId, organizationId: identity.organizationId, memberId: identity.memberId || 'local-user', type, recordId, context } : null;
}
export function useVerifiedFormDraftScope(workspace:Pick<Workspace,'workNotesScope'>|undefined,type:string,recordId?:string) {
  const identity=useContext(FormDraftIdentity),companyId=workspace?.workNotesScope||identity.companyId;
  return companyId && identity.ready===true && typeof identity.memberId==='string' && Boolean(identity.memberId.trim()) ? {companyId,organizationId:identity.organizationId,memberId:identity.memberId,type,recordId} : null;
}
export function draftText(source: keyof typeof formDraftTranslations): string {
  const index = { fr: -1, de: 0, it: 1, en: 2 }[getAppLanguage()];
  return index < 0 ? source : formDraftTranslations[source][index];
}
export function useFormDraft<T>(options: FormDraftOptions<T>) {
  const [session] = useState(() => new FormDraftSession(options));
  session.updateOptions(options);
  const [, render] = useState(0), mounted = useRef(true);
  const refresh = () => { if (mounted.current) render(value => value + 1); };
  useEffect(() => {
    mounted.current = true;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (session.needsCloseConfirmation()) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mounted.current = false; window.removeEventListener('beforeunload', beforeUnload); };
  }, [session]);
  const setValue = (next: SetStateAction<T>) => {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(session.getSnapshot().value) : next;
    session.capture(value); refresh();
  };
  const snapshot = session.getSnapshot();
  return { ...snapshot, conflict: session.hasConflict(), setValue,
    restore: () => { session.restore(); refresh(); },
    keepLocal: () => { session.keepLocal(); refresh(); },
    discard: () => { session.reset(); refresh(); return !session.getSnapshot().dirty && !session.getSnapshot().pending; },
    complete: (saved: boolean) => { session.complete(saved); refresh(); },
    retryStorage: () => { session.retryStorage(); refresh(); },
    close: (close: () => void) => { if (!session.needsCloseConfirmation() || window.confirm(draftText('La dernière saisie ne peut pas être conservée sur cet appareil. Fermer et perdre les modifications ?'))) close(); },
  };
}
export type FormDraftControls = Pick<ReturnType<typeof useFormDraft<unknown>>, 'pending' | 'dirty' | 'conflict' | 'storageError' | 'invalid' | 'completedResidual' | 'completionProtected' | 'savedAt' | 'restore' | 'keepLocal' | 'retryStorage'> & { discard: () => void };
export function FormDraftNotice({ draft, disabled = false, currentValues }: { draft: FormDraftControls; disabled?: boolean; currentValues?: readonly { label: string; value: string }[] }) {
  useAppLanguage();
  const abandon = () => { if (window.confirm(draftText('Abandonner ce brouillon et retrouver les valeurs enregistrées ?'))) draft.discard(); };
  if (!draft.pending && !draft.dirty && !draft.invalid && !draft.conflict && !draft.completedResidual) return null;
  return <aside className={`form-draft-notice${draft.storageError || draft.conflict ? ' form-draft-notice--warning' : ''}`} aria-label={draftText('Brouillon local')}>
    <div role={draft.storageError || draft.conflict ? 'alert' : 'status'}>
      <strong>{draftText(draft.completedResidual ? 'L’enregistrement est confirmé' : draft.pending ? 'Une saisie vous attend sur cet appareil' : draft.conflict ? 'Les données enregistrées ont changé' : draft.storageError ? 'La saisie locale ne peut pas être conservée' : draft.invalid ? 'Ce brouillon ne peut plus être repris' : 'Saisie conservée sur cet appareil')}</strong>
      {draft.completedResidual && <p>{draftText(draft.completionProtected ? 'Le brouillon local n’a pas pu être effacé. Il ne sera pas repris ni envoyé à nouveau. Vérifiez la fiche enregistrée.' : 'La confirmation locale ne peut pas être conservée. Vérifiez la fiche enregistrée avant de reprendre une saisie après redémarrage.')}</p>}
      {!draft.completedResidual && (draft.pending || draft.conflict || draft.storageError || draft.invalid) && <p>{draftText(draft.pending && draft.conflict ? 'Les données ont changé depuis cette saisie. Reprenez-la pour comparer avant de choisir.' : draft.conflict ? 'Votre saisie est affichée. Comparez-la avec les valeurs actuelles avant de choisir ; rien n’est envoyé automatiquement.' : draft.pending ? 'Reprenez-la pour la vérifier, puis enregistrez quand vous êtes prêt.' : draft.storageError ? 'Gardez ce formulaire ouvert. Vérifiez l’espace disponible et réessayez de conserver la saisie.' : 'Il est trop ancien ou son format a changé. Retrouvez les valeurs enregistrées pour continuer.')}</p>}
      {draft.conflict && currentValues?.length ? <details className="form-draft-notice__comparison"><summary>{draftText('Voir les valeurs actuelles')}</summary><dl>{currentValues.map((row, index) => <div key={index}><dt>{row.label}</dt><dd>{row.value || '—'}</dd></div>)}</dl></details> : null}
    </div>
    <div className="form-draft-notice__actions">
      {draft.pending && <Button type="button" size="small" variant="secondary" disabled={disabled} onClick={draft.restore}>{draftText('Reprendre ma saisie')}</Button>}
      {!draft.pending && draft.conflict && <Button type="button" size="small" variant="secondary" disabled={disabled} onClick={draft.keepLocal}>{draftText('Conserver ma saisie')}</Button>}
      {draft.storageError && draft.dirty && <Button type="button" size="small" variant="secondary" disabled={disabled} onClick={draft.retryStorage}>{draftText('Réessayer la sauvegarde locale')}</Button>}
      <Button type="button" size="small" variant="ghost" disabled={disabled} onClick={abandon}>{draftText(draft.conflict ? 'Utiliser les valeurs actuelles' : 'Abandonner le brouillon')}</Button>
    </div>
  </aside>;
}
