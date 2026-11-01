import type { ComponentType, ReactNode } from 'react';
import RubberSegmentSource from './reactbits/RubberSegment';

// The React Bits source is plain JavaScript; its props are typed here.
const RubberSegment = RubberSegmentSource as unknown as ComponentType<Record<string, unknown>>;

export type ZSegmentItem<T extends string> = { value: T; label: ReactNode; icon?: ReactNode };

/** The one segmented choice of the app (React Bits RubberSegment in Zentra colours). */
export function ZSegment<T extends string>({ items, value, onChange, ariaLabel, size = 'md', disabled = false, equalSlots = true, className }: {
  items: ZSegmentItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  equalSlots?: boolean;
  className?: string;
}) {
  return <RubberSegment items={items} value={value} onChange={(next: T) => onChange(next)} aria-label={ariaLabel} size={size} disabled={disabled} equalSlots={equalSlots} className={className} />;
}
