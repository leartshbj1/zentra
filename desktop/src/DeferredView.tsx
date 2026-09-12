import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { LoaderCircle, RefreshCw } from 'lucide-react';
import { Button, Modal } from './ui';
import { createModuleLoader } from './moduleLoader';
import './deferred-view.css';

/** Defer optional screens without hiding the workspace or remounting a surrounding form. */
export function deferView<C extends ComponentType<any>>(
  importView: () => Promise<{ default: C }>,
  options: { label: string; close?: (props: NoInfer<ComponentProps<C>>) => () => void },
): ComponentType<ComponentProps<C>> {
  type P = ComponentProps<C>;
  const loader = createModuleLoader(importView);
  return function DeferredView(props: P) {
    const [module, setModule] = useState(() => loader.peek());
    const [failed, setFailed] = useState(false);
    const [attempt, setAttempt] = useState(0);
    const statusRef = useRef<HTMLElement>(null);
    useEffect(() => {
      if (module) return;
      let active = true;
      loader.load().then(
        loaded => { if (active) { setModule(loaded); setFailed(false); } },
        () => { if (active) setFailed(true); },
      );
      return () => { active = false; };
    }, [module, attempt]);
    if (module) {
      const Screen: ComponentType<P> = module.default;
      return <Screen {...props} />;
    }
    const content = <section ref={statusRef} tabIndex={-1} className="deferred-view" role={failed ? 'alert' : 'status'} aria-label={options.label}>
      {!failed && <LoaderCircle className="spin" size={22} aria-hidden="true" />}
      <div>
        <strong>{failed ? 'Cet écran n’a pas pu s’ouvrir.' : options.label}</strong>
        {failed && <p>Votre espace reste ouvert. Réessayez l’ouverture ; les informations déjà saisies dans le formulaire précédent sont conservées.</p>}
        {failed && <p>Si le problème persiste, revenez au formulaire précédent, enregistrez votre travail puis relancez Zentra.</p>}
      </div>
      {failed && <Button type="button" variant="secondary" onClick={() => {
        // The retry button disappears during loading; retain keyboard focus inside the dialog.
        statusRef.current?.focus({ preventScroll: true });
        setFailed(false);
        setAttempt(value => value + 1);
      }}>
        <RefreshCw size={16} /> Réessayer l’ouverture
      </Button>}
    </section>;
    return options.close ? <Modal title={options.label} onClose={options.close(props)}>{content}</Modal> : content;
  };
}
