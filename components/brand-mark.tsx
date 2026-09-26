import { cn } from '@/lib/utils';

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={cn('shrink-0', className)}
      focusable="false"
      viewBox="0 0 256 256"
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href="/brand/zentra-symbol-20260926.png" width="256" height="256" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return (
    <span className="zentra-brand-identity"><BrandMark className="zentra-brand-identity__symbol"/><img
      alt="Zentra"
      className={cn('block h-auto object-contain', className)}
      height="68"
      src="/brand/zentra-wordmark.png"
      width="202"
    /></span>
  );
}
