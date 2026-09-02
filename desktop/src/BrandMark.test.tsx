import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://local/${encodeURIComponent(path)}`,
}));

import { CompanyAvatar, companyInitials } from './BrandMark';

describe('identité visuelle de l’entreprise', () => {
  it('construit des initiales lisibles sans logo', () => {
    expect(companyInitials('Atelier du Lac')).toBe('AD');
    expect(companyInitials('Zentra')).toBe('ZE');
    expect(companyInitials('')).toBe('ZE');

    const html = renderToStaticMarkup(
      <CompanyAvatar organization={{ legalName: 'Atelier du Lac', logoPath: '' }} />,
    );
    expect(html).toContain('aria-label="Entreprise : Atelier du Lac"');
    expect(html).toContain('>AD</span>');
    expect(html).not.toContain('<img');
  });

  it('affiche la copie locale du logo avec un fallback sémantique', () => {
    const html = renderToStaticMarkup(
      <CompanyAvatar
        organization={{
          legalName: 'Atelier du Lac',
          logoPath: 'C:\\Zentra\\attachments\\branding\\logo.png',
        }}
      />,
    );
    expect(html).toContain('<img');
    expect(html).toContain('asset://local/');
    expect(html).toContain('aria-label="Entreprise : Atelier du Lac"');
    expect(html).toContain('aria-hidden="true"');
  });
});
