import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      focusable="false"
      viewBox="0 0 40 40"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="40" height="40" rx="12" fill="#173d2c" />
      <path
        d="M10 9.5A2.5 2.5 0 0 1 12.5 7H30a3 3 0 0 1 0 6H16v4h10a3 3 0 0 1 0 6H16v4h14a3 3 0 0 1 0 6H12.5A2.5 2.5 0 0 1 10 30.5v-21Z"
        fill="#efaa3c"
      />
    </svg>
  );
}
