import { lazy, Suspense, useState } from 'react';
import { Mail } from 'lucide-react';
import { Button } from './ui';
import type { MailTarget } from './outgoingMail';
const Composer = lazy(() => import('./OutgoingMailPanel').then(module => ({ default: module.MailComposer })));
const Settings = lazy(() => import('./OutgoingMailPanel').then(module => ({ default: module.MailSettings })));
export function MailSettings(props: Parameters<typeof Settings>[0]) { return <Suspense fallback={<p role="status">Ouverture de la messagerie…</p>}><Settings {...props} /></Suspense>; }
export function MailComposer(props: Parameters<typeof Composer>[0]) { return <Suspense fallback={<p role="status">Ouverture de l’e-mail…</p>}><Composer {...props} /></Suspense>; }
export function MailDocumentButton({ target, disabled = false, onSent }: { target: MailTarget; disabled?: boolean; onSent?: () => void }) {
  const [open, setOpen] = useState(false);
  return <><Button type="button" variant="secondary" disabled={disabled} onClick={() => setOpen(true)}><Mail size={16} />Envoyer par e-mail</Button>{open && <MailComposer target={target} onClose={() => setOpen(false)} onSent={onSent} />}</>;
}
