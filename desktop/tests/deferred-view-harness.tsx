import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { deferView } from '../src/DeferredView';
import { Button, Field } from '../src/ui';
import '../src/styles.css';
import '../src/mobile.css';

declare global { interface Window { deferredFixture: {
  calls: number; loaded: boolean; fail: boolean; release: () => void; changeEmployee: (name: string) => void;
} } }
window.deferredFixture = { calls: 0, loaded: false, fail: false, release() {}, changeEmployee() {} };
const Dialog = deferView(async () => {
  window.deferredFixture.calls++;
  await new Promise<void>(resolve => { window.deferredFixture.release = resolve; });
  if (window.deferredFixture.fail) throw new Error('Synthetic loading refusal');
  const module = await import('./deferred-view-fixture');
  window.deferredFixture.loaded = true;
  return { default: module.DeferredTestDialog };
}, { label: 'Ouverture de la fiche…', close: props => props.close });
function Harness() {
  const [open, setOpen] = useState(false), [employee, setEmployee] = useState('Camille');
  const [note, setNote] = useState('Brouillon à conserver');
  window.deferredFixture.changeEmployee = setEmployee;
  return <main style={{ padding: 20 }}>
    <Field label="Notes du formulaire précédent"><input value={note} onChange={event => setNote(event.target.value)} /></Field>
    <Button onClick={() => setOpen(true)}>Ouvrir une fiche</Button>
    {open && <Dialog employee={employee} close={() => setOpen(false)} />}
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>);
