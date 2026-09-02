import { LogOut } from 'lucide-react';
import type { ZentraUser } from '@/app/zentra-auth';
import { chatGPTSignOutPath } from '@/app/chatgpt-auth';
import { safeAuthReturnPath } from '@/lib/supabase-auth-http';

export function ZentraSignOut({
  provider,
  returnTo,
}: {
  provider: ZentraUser['provider'];
  returnTo: string;
}) {
  const className =
    'inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-full border border-[#c8c4ba] bg-white px-5 text-sm font-semibold';
  if (provider === 'sites') {
    return (
      <a href={chatGPTSignOutPath(returnTo)} className={className}>
        <LogOut className="size-4" /> Déconnexion
      </a>
    );
  }

  const safeReturnTo = safeAuthReturnPath(returnTo);
  return (
    <form
      method="post"
      action={`/api/auth/deconnexion?retour=${encodeURIComponent(safeReturnTo)}`}
      className="self-start"
    >
      <button type="submit" className={className}>
        <LogOut className="size-4" /> Déconnexion
      </button>
    </form>
  );
}
