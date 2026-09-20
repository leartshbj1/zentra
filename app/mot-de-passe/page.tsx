import { PasswordRecoveryForm } from '@/components/password-recovery-form';
export const metadata = {
  title: 'Mot de passe oublié — Zentra',
  robots: { index: false, follow: false },
};
export default function PasswordRecoveryPage() {
  return <PasswordRecoveryForm />;
}
