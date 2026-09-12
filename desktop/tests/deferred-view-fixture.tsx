import { useState } from 'react';
import { Field, Modal } from '../src/ui';

export function DeferredTestDialog({ employee, close }: { employee: string; close: () => void }) {
  const [note, setNote] = useState('');
  return <Modal title={`La fiche de ${employee}`} onClose={close}>
    <Field label="Notes de la fiche"><input value={note} onChange={event => setNote(event.target.value)} /></Field>
  </Modal>;
}
