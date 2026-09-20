import { getZentraUser, type ZentraUser } from '@/app/zentra-auth';
import { requireBrowserMembership, requireDeviceSession } from '@/lib/account';
import { AccountPublicError } from '@/lib/account-security';
import { runtimeValue } from '@/lib/runtime';
import { requireSameOrigin } from '@/lib/stripe';

export function isAutomationFounder(user: ZentraUser | null) {
  return (
    !!user &&
    user.provider === 'supabase' &&
    user.emailConfirmed &&
    !!runtimeValue('ZENTRA_OWNER_EMAIL') &&
    user.email.toLowerCase() ===
      runtimeValue('ZENTRA_OWNER_EMAIL').toLowerCase()
  );
}
export async function requireAutomationFounder(request: Request) {
  requireSameOrigin(request);
  const user = await getZentraUser({ refreshSession: true });
  if (!isAutomationFounder(user))
    throw new AccountPublicError(
      'Cet espace est réservé au compte fondateur Zentra.',
      403,
    );
  return user!;
}
export type AutomationActor = {
  organizationId: string;
  userId: string;
  role: string;
  founder: boolean;
  device?: boolean;
};
export async function automationActor(
  request: Request,
  organizationId: unknown,
  manage = false,
): Promise<AutomationActor> {
  // Browser cookies and device Bearer sessions never substitute for each other.
  if (request.headers.has('Authorization')) {
    if (
      request.headers.has('Origin') &&
      ![
        'tauri://localhost',
        'http://tauri.localhost',
        'https://tauri.localhost',
      ].includes(request.headers.get('Origin')!)
    )
      throw new AccountPublicError('Ouvrez cette action dans Zentra.', 403);
    const session = await requireDeviceSession(
      request,
      manage ? ['owner', 'admin'] : undefined,
    );
    if (
      typeof organizationId === 'string' &&
      organizationId !== session.organizationId
    )
      throw new AccountPublicError(
        'Cette entreprise n’est pas accessible.',
        403,
      );
    return { ...session, founder: false, device: true };
  }
  if (request.method !== 'GET') requireSameOrigin(request);
  const user = await getZentraUser({ refreshSession: true });
  if (!user)
    throw new AccountPublicError('Connectez-vous à votre compte Zentra.', 401);
  if (typeof organizationId !== 'string' || !organizationId)
    throw new AccountPublicError('Choisissez votre entreprise.');
  const member = await requireBrowserMembership(
    user.userId,
    organizationId,
    manage ? ['owner', 'admin'] : undefined,
  );
  return { ...member, userId: user.userId, founder: isAutomationFounder(user) };
}
