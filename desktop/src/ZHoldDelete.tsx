import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import HoldButtonSource from './reactbits/HoldButton';
import { t, useAppLanguage } from './language';

// The React Bits source is plain JavaScript; its props are typed here.
const HoldButton = HoldButtonSource as unknown as ComponentType<Record<string, unknown>>;

/** A delete action you confirm by holding it (React Bits HoldButton, quiet Zentra red). A short tap only says how. */
export function ZHoldDelete({ children, onConfirm, disabled = false, ariaLabel, size = 'sm', doneLabel, className }: {
  children?: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  ariaLabel?: string;
  size?: 'sm' | 'md' | 'lg';
  doneLabel?: ReactNode;
  className?: string;
}) {
  useAppLanguage();
  const [hinting, setHinting] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const showHint = () => {
    setHinting(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setHinting(false), 1600);
  };
  return <HoldButton size={size} disabled={disabled} ariaLabel={ariaLabel} className={className}
    icon={<Trash2 size={size === 'sm' ? 14 : 16} aria-hidden="true" />}
    doneLabel={doneLabel ?? t('Supprimé')}
    hint={t('Maintenez le bouton environ une seconde pour confirmer la suppression.')}
    onTap={showHint}
    onHold={() => { setHinting(false); onConfirm(); }}>
    {hinting ? t('Maintenez pour confirmer') : (children ?? t('Supprimer'))}
  </HoldButton>;
}
