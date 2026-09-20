import { database } from '@/lib/runtime';
import { AuthPublicError } from '@/lib/supabase-auth-http';

export type AccountPreferences = {
  theme: 'system' | 'light' | 'dark';
  companyDraft: string;
  onboardingCompletedAt: number | null;
  revision: number;
};
export async function accountPreferences(userId: string): Promise<AccountPreferences> {
  const row = await database().prepare('SELECT * FROM account_preferences WHERE user_id=?').bind(userId)
    .first<{ theme: AccountPreferences['theme']; company_draft: string; onboarding_completed_at: number | null; revision: number }>();
  return row ? { theme: row.theme, companyDraft: row.company_draft, onboardingCompletedAt: row.onboarding_completed_at, revision: row.revision }
    : { theme: 'system', companyDraft: '', onboardingCompletedAt: null, revision: 0 };
}
export async function saveAccountPreferences(userId: string, input: Record<string, unknown>) {
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
    throw new AuthPublicError('Rechargez les réglages avant de les enregistrer.', 409);
  const old = await accountPreferences(userId);
  if (old.revision !== input.revision) throw new AuthPublicError('Ces réglages ont changé sur un autre appareil. Rechargez la page.', 409);
  const theme = input.theme ?? old.theme;
  const companyDraft = typeof input.companyDraft === 'string' ? input.companyDraft.trim() : old.companyDraft;
  if (!['system', 'light', 'dark'].includes(String(theme)) || companyDraft.length > 120)
    throw new AuthPublicError('Vérifiez le nom de l’entreprise et l’apparence.');
  const completed = input.completeOnboarding === true ? Math.floor(Date.now() / 1000) : old.onboardingCompletedAt;
  // Compare-and-swap also handles two simultaneous first saves.
  const result = await database().prepare(`INSERT INTO account_preferences(user_id,theme,company_draft,onboarding_completed_at,revision,updated_at)
    SELECT ?,?,?,?,?,? WHERE ?=0 OR EXISTS(SELECT 1 FROM account_preferences WHERE user_id=? AND revision=?)
    ON CONFLICT(user_id) DO UPDATE SET theme=excluded.theme,company_draft=excluded.company_draft,
    onboarding_completed_at=excluded.onboarding_completed_at,revision=account_preferences.revision+1,updated_at=excluded.updated_at
    WHERE account_preferences.revision=?`).bind(userId, theme, companyDraft, completed, 1, Math.floor(Date.now()/1000), input.revision, userId, input.revision, input.revision).run();
  if (!result.meta.changes) throw new AuthPublicError('Ces réglages ont changé. Rechargez la page.', 409);
  return accountPreferences(userId);
}
