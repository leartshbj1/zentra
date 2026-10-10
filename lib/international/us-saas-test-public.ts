import type { publicWorkspaceCreation } from './workspace-creation';
export interface UsTestPublicOffer {
  readonly module: 'gestion' | 'complet'; readonly plan: string; readonly catalogVersion: string;
  readonly amountMinor: string; readonly currency: 'USD'; readonly interval: 'month' | 'year';
  readonly intervalCount: number; readonly seatLimit: number;
}
export interface UsTestPublicState {
  readonly workspace: ReturnType<typeof publicWorkspaceCreation>;
  readonly offers: readonly UsTestPublicOffer[];
  readonly purchase: { readonly state: 'not_started' | 'checkout_pending' | 'ready'; readonly expiresAt?: number; readonly module?: 'gestion' | 'complet'; readonly plan?: string };
  readonly checkoutUrl?: string | null;
}
