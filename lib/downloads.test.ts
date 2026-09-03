import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  ZENTRA_INSTALLER_CHECKSUM_PATH,
  ZENTRA_INSTALLER_NAME,
  ZENTRA_INSTALLER_PATH,
  ZENTRA_INSTALLER_SHA256,
  ZENTRA_MAC_DMG_CHECKSUM_PATH,
  ZENTRA_MAC_DMG_NAME,
  ZENTRA_MAC_DMG_PATH,
  ZENTRA_MAC_DMG_SHA256,
  ZENTRA_RELEASES_ORIGIN,
  ZENTRA_VERSION,
} from './downloads';

type UpdaterManifest = {
  version: string;
  platforms: Record<string, { signature: string; url: string }>;
};

const manifest = JSON.parse(
  readFileSync(
    new URL('../public/downloads/latest.json', import.meta.url),
    'utf8',
  ),
) as UpdaterManifest;

describe('contrat de téléchargement Zentra', () => {
  it('centralise une version et des empreintes bien formées', () => {
    expect(ZENTRA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ZENTRA_INSTALLER_SHA256).toMatch(/^[A-F0-9]{64}$/);
    expect(ZENTRA_MAC_DMG_SHA256).toMatch(/^[A-F0-9]{64}$/);
  });

  it('construit des chemins immuables pour les deux installateurs visibles', () => {
    expect(ZENTRA_INSTALLER_NAME).toBe(
      `Zentra_${ZENTRA_VERSION}_x64-setup.exe`,
    );
    expect(ZENTRA_INSTALLER_PATH).toBe(
      `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_INSTALLER_NAME}`,
    );
    expect(ZENTRA_INSTALLER_CHECKSUM_PATH).toBe(
      `${ZENTRA_INSTALLER_PATH}.sha256.txt`,
    );

    expect(ZENTRA_MAC_DMG_NAME).toBe(
      `Zentra_${ZENTRA_VERSION}_macos-universal.dmg`,
    );
    expect(ZENTRA_MAC_DMG_PATH).toBe(
      `${ZENTRA_RELEASES_ORIGIN}/${ZENTRA_MAC_DMG_NAME}`,
    );
    expect(ZENTRA_MAC_DMG_CHECKSUM_PATH).toBe(
      `${ZENTRA_MAC_DMG_PATH}.sha256.txt`,
    );
  });

  it('garde le manifeste public aligné avec Windows et macOS', () => {
    expect(manifest.version).toBe(ZENTRA_VERSION);
    expect(Object.keys(manifest.platforms).sort()).toEqual([
      'macos-universal',
      'windows-x86_64',
    ]);

    const windows = manifest.platforms['windows-x86_64'];
    const macos = manifest.platforms['macos-universal'];
    expect(windows.url).toBe(ZENTRA_INSTALLER_PATH);
    expect(macos.url).toBe(
      `${ZENTRA_RELEASES_ORIGIN}/Zentra_${ZENTRA_VERSION}_macos-universal.app.tar.gz`,
    );
    expect(windows.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(macos.signature).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(macos.url).not.toBe(ZENTRA_MAC_DMG_PATH);
  });
});
