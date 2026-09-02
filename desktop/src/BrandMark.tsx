import { convertFileSrc } from '@tauri-apps/api/core';
import wordmarkUrl from './assets/zentra-wordmark.png';
import type { Organization } from './types';

export function BrandMark({ size = 40, className }: { size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height={size}
      viewBox="0 0 40 40"
      width={size}
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
  return <img alt="Zentra" className={className} src={wordmarkUrl} />;
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
