import { isAccountRole } from '../account-security';
import type { AccountWorkspace } from '../account-workspaces';
import { creationUuid } from './workspace-creation';
import { usDeviceDisplayText } from './us-device-display-text';

export type UsApprovalLanguage = 'fr' | 'de' | 'it' | 'en';
export interface UsApprovalUser { readonly userId: string; readonly email: string }
export interface UsApprovalPagePorts {
  enabled(): Promise<boolean>;
  user(): Promise<UsApprovalUser | null>;
  discover(userId: string): Promise<readonly AccountWorkspace[]>;
}
export type UsApprovalPageState = Readonly<{ language: UsApprovalLanguage; initialCode: string; returnTo: string }> & (
  | Readonly<{ status: 'disabled' | 'unavailable' | 'unauthenticated' }>
  | Readonly<{ status: 'ready'; user: UsApprovalUser; workspaces: readonly AccountWorkspace[] }>
);

/** Discovery is display metadata only. Approval separately rechecks authority,
 * membership, seats and the exact pending challenge on the server. */
export async function loadUsApprovalPage(ports: UsApprovalPagePorts, params: { code?: unknown; lang?: unknown }): Promise<UsApprovalPageState> {
  const language: UsApprovalLanguage = params.lang === 'de' || params.lang === 'it' || params.lang === 'en' ? params.lang : 'fr';
  const initialCode = typeof params.code === 'string' && params.code.length <= 32 ? params.code : '';
  const query = new URLSearchParams({ lang: language }); if (initialCode) query.set('code', initialCode);
  const base = { language, initialCode, returnTo: '/appareil/us?' + query.toString() };
  try {
    if (!await ports.enabled()) return { ...base, status: 'disabled' };
    const user = await ports.user(); if (!user) return { ...base, status: 'unauthenticated' };
    creationUuid(user.userId);
    if (!usDeviceDisplayText(user.email,256)) throw new Error('Invalid public identity');
    const all = await ports.discover(user.userId);
    if (!Array.isArray(all)) throw new Error('Invalid discovery');
    const workspaces = all.filter(row => row.edition === 'us_experimental').map(row => {
      creationUuid(row.organizationId);
      if (!isAccountRole(row.role) || !usDeviceDisplayText(row.name,160)) throw new Error('Invalid discovery');
      return Object.freeze({ organizationId: row.organizationId, name: row.name, edition: 'us_experimental' as const, role: row.role });
    });
    if (new Set(workspaces.map(row => row.organizationId)).size !== workspaces.length) throw new Error('Ambiguous discovery');
    const fresh = await ports.user();
    if (!fresh || fresh.userId !== user.userId) return { ...base, status: 'unauthenticated' };
    if (!usDeviceDisplayText(fresh.email,256)) throw new Error('Invalid public identity');
    if (!await ports.enabled()) return { ...base, status: 'disabled' };
    return { ...base, status: 'ready', user: Object.freeze({ userId: user.userId, email: fresh.email }), workspaces: Object.freeze(workspaces) };
  } catch { return { ...base, status: 'unavailable' }; }
}
