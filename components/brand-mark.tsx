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
      <rect width="40" height="40" rx="12" fill="#f7f5ef" />
      <path
        d="M10.5 8h19a3 3 0 0 1 2.2 5.04L17.25 27H29.5a3 3 0 1 1 0 6h-19a3 3 0 0 1-2.2-5.04L22.75 14H10.5a3 3 0 1 1 0-6Z"
        fill="#124832"
      />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <img
      alt="Zentra"
      className={cn('block h-auto object-contain', className)}
      height="68"
      src="/brand/zentra-wordmark.png"
      width="202"
    />
  );
}
