import { PasswordRecoveryForm } from '@/components/password-recovery-form';
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Nouveau mot de passe — Zentra',
  robots: { index: false, follow: false },
  referrer: 'no-referrer' as const,
};
export default function NewPasswordPage() {
  return <PasswordRecoveryForm reset />;
}
