import { PasswordRecoveryForm } from '@/components/password-recovery-form';
export const metadata = { title: 'Nouveau mot de passe — Zentra' };
export default function NewPasswordPage() {
  return <PasswordRecoveryForm reset />;
}
