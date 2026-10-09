'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';

/** A head is acknowledged only after an admitted read has been applied. */
export interface UsBackgroundChannel { refresh(): Promise<boolean>; due?(): boolean; invalidate?(): void }
export type UsBackgroundRegistration = (channel: UsBackgroundChannel | null) => void;

export const usBackgroundDraftCopy = {
  en: { changed: 'This profile changed elsewhere. Review the saved details before saving your draft.', review: 'Use this revision for my draft', saved: 'Saved details' },
  fr: { changed: 'Ce profil a changé ailleurs. Vérifiez les données enregistrées avant de sauvegarder votre brouillon.', review: 'Utiliser cette révision pour mon brouillon', saved: 'Données enregistrées' },
  de: { changed: 'Dieses Profil wurde anderswo geändert. Prüfen Sie die gespeicherten Angaben, bevor Sie Ihren Entwurf speichern.', review: 'Diese Revision für meinen Entwurf verwenden', saved: 'Gespeicherte Angaben' },
  it: { changed: 'Questo profilo è cambiato altrove. Verifica i dati salvati prima di salvare la bozza.', review: 'Usa questa revisione per la mia bozza', saved: 'Dati salvati' },
} as const;

/** Keep panel instances and their exact pending operations mounted. The
 * coordinator always calls the latest closure without re-registering on edits. */
export function useUsBackgroundChannel(register: UsBackgroundRegistration | undefined, refresh: () => Promise<boolean>, due?: () => boolean, invalidate?: () => void) {
  const latest = useRef({ refresh, due, invalidate });
  useLayoutEffect(() => { latest.current = { refresh, due, invalidate }; });
  useEffect(() => {
    if (!register) return;
    register({ refresh: () => latest.current.refresh(), due: () => latest.current.due?.() ?? false, invalidate: () => latest.current.invalidate?.() });
    return () => register(null);
  }, [register]);
}
