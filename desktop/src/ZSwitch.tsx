import type { ComponentType } from 'react';
import SquishSwitchSource from './reactbits/SquishSwitch';

// The React Bits source is plain JavaScript; its props are typed here.
const SquishSwitch = SquishSwitchSource as unknown as ComponentType<Record<string, unknown>>;

/** The one on/off switch of the app (React Bits SquishSwitch in Zentra colours). Inside a <label>, the label names it. */
export function ZSwitch({ checked, onChange, disabled = false, ariaLabel, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return <SquishSwitch checked={checked} onChange={(next: boolean) => { if (!disabled) onChange(next); }} disabled={disabled} ariaLabel={ariaLabel} className={className} />;
}
