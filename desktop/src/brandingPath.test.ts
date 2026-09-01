import { describe, expect, it } from 'vitest';
import { rebaseStoredBrandingPath } from './bridge';

describe('rebasing du logo restauré', () => {
  const name = `logo-${'a'.repeat(64)}.png`;

  it('rebascule un logo immuable hashé vers APPLOCALDATA courant', () => {
    expect(rebaseStoredBrandingPath(`C:\\Users\\ancien\\AppData\\Local\\Zentra\\attachments\\branding\\${name}`, 'D:\\Profil\\Zentra'))
      .toBe(`D:\\Profil\\Zentra\\attachments\\branding\\${name}`);
  });

  it('ne transforme pas un ancien chemin arbitraire non géré', () => {
    expect(rebaseStoredBrandingPath('C:\\Images\\logo-client.png', 'D:\\Profil\\Zentra')).toBe('C:\\Images\\logo-client.png');
  });
});
