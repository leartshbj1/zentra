import wordmarkUrl from './assets/zentra-wordmark.png';
import symbolUrl from './assets/zentra-symbol-20260926.png';

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height={size}
      viewBox="0 0 256 256"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <image href={symbolUrl} width="256" height="256" />
    </svg>
  );
}

export function BrandWordmark({ className }: { className?: string }) {
  return <span className="zentra-brand-identity"><BrandMark className="zentra-brand-identity__symbol" size={32}/><img alt="Zentra" className={className} src={wordmarkUrl} width={202} height={68}/></span>;
}


