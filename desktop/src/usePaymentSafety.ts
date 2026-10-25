import { useCallback, useEffect, useState } from 'react';
import { desktopApi } from './bridge';
import type { PaymentSafetyOverview } from './paymentSafety';

// L'équipe est lue une fois par session : une entreprise d'une seule personne
// garde les alertes sans être bloquée par la double validation.
let teamRead = false;

export async function loadPaymentSafety(): Promise<PaymentSafetyOverview> {
  const overview = await desktopApi.paymentSafetyOverview();
  if (teamRead || !overview.actor.userId || overview.actor.userId === 'local-user') return overview;
  teamRead = true;
  try {
    const team = await desktopApi.getCloudTeam();
    await desktopApi.rememberCompanyTeamSize(team.members.length);
    return await desktopApi.paymentSafetyOverview();
  } catch {
    return overview;
  }
}

/** Contrôles, historique et double validation des factures à payer, relus à chaque changement. */
export function usePaymentSafety(trigger: unknown) {
  const [overview, setOverview] = useState<PaymentSafetyOverview | null>(null);
  const refresh = useCallback(async () => {
    try { setOverview(await loadPaymentSafety()); } catch { setOverview(null); }
  }, []);
  useEffect(() => { void refresh(); }, [trigger, refresh]);
  return { overview, refresh };
}
