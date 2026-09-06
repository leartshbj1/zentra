import { useState } from 'react';
import { UserRound } from 'lucide-react';
import { CloudAccountPanel } from './CloudAccountPanel';
import type { CloudAccountState } from './bridge';
import { Button, Modal } from './ui';

export function CloudAccountAccess({ account, onAccountChange }: {
  account?: CloudAccountState | null;
  onAccountChange?: (account: CloudAccountState) => void;
}) {
  const [open, setOpen] = useState(false);
  const connected = account?.status === 'connected';
  const label = connected ? 'Mon compte' : 'Se connecter';
  return <>
    <Button type="button" variant="secondary" size="small" className="account-launcher" aria-label={label} onClick={() => setOpen(true)}><UserRound size={17} /><span>{label}</span></Button>
    {open ? <Modal title={connected ? 'Mon compte Zentra' : 'Se connecter à Zentra'} wide onClose={() => setOpen(false)}><CloudAccountPanel onAccountChange={onAccountChange} /></Modal> : null}
  </>;
}
