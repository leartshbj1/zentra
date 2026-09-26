import { convertFileSrc } from '@tauri-apps/api/core';
import wordmarkUrl from './assets/zentra-wordmark.png';
import symbolUrl from './assets/zentra-symbol-20260926.png';
import type { Organization } from './types';

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

export function companyInitials(legalName: string) {
  const words = legalName.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'ZE';
  if (words.length === 1) return words[0].slice(0, 2).toLocaleUpperCase('fr-CH');
  return `${words[0][0] ?? ''}${words[1][0] ?? ''}`.toLocaleUpperCase('fr-CH');
}

export function CompanyAvatar({
  organization,
  className,
}: {
  organization: Pick<Organization, 'legalName' | 'logoPath'>;
  className?: string;
}) {
  const legalName = organization.legalName.trim() || 'Entreprise';
  const classes = ['company-avatar', className].filter(Boolean).join(' ');
  return (
    <div className={classes} role="img" aria-label={`Entreprise : ${legalName}`} title={legalName}>
      {organization.logoPath ? (
        <img src={convertFileSrc(organization.logoPath)} alt="" aria-hidden="true" />
      ) : (
        <span aria-hidden="true">{companyInitials(legalName)}</span>
      )}
    </div>
  );
}
