import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('contrat de publication des mises à jour', () => {
  it('sépare la clé Minisign updater de la clé brute des licences', () => {
    const updaterKey = readFileSync(
      new URL('../src-tauri/updater-public-key.b64', import.meta.url),
      'utf8',
    ).trim();
    const licenseKey = readFileSync(
      new URL('../src-tauri/license-public-key.b64url', import.meta.url),
      'utf8',
    ).trim();
    const document = Buffer.from(updaterKey, 'base64').toString('utf8');

    expect(document).toMatch(/^untrusted comment: minisign public key:/m);
    expect(document).toMatch(/^RW[A-Za-z0-9+/=]+$/m);
    expect(document).not.toMatch(/private key/i);
    expect(updaterKey).not.toBe(licenseKey);
  });

  it('charge la clé updater dédiée et injecte sa configuration au build macOS', () => {
    const workflow = readFileSync(
      new URL('../../.github/workflows/macos-updater.yml', import.meta.url),
      'utf8',
    );
    const script = readFileSync(
      new URL('../scripts/build-macos-updater-preview.sh', import.meta.url),
      'utf8',
    );
    const localBuild = readFileSync(
      new URL('../scripts/build-local-signed-updater.ps1', import.meta.url),
      'utf8',
    );
    const staging = readFileSync(
      new URL('../scripts/stage-updater-release.ps1', import.meta.url),
      'utf8',
    );
    const workflowEndpoint =
      'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases/latest.json';

    expect(workflow).toContain('desktop/src-tauri/updater-public-key.b64');
    expect(workflow).toContain(`ELYKO_UPDATER_ENDPOINT: ${workflowEndpoint}`);
    expect(workflow).not.toContain(
      'ELYKO_UPDATER_ENDPOINT: https://elyko.alb-leart1.chatgpt.site',
    );
    expect(localBuild).toContain(workflowEndpoint);
    expect(staging).toContain(
      'https://xvfohjdlhlirksrvkiqu.supabase.co/storage/v1/object/public/zentra-releases',
    );
    expect(workflow).not.toContain(
      'public_key="$(tr -d \'\\r\\n\' < desktop/src-tauri/license-public-key.b64url)"',
    );
    expect(script).toContain('updater: updaterConfig.plugins.updater');
    expect(script).toContain('--config "$generated_config"');
    expect(script).toContain('MACOS_UPDATER_PREVIEW.md');
    expect(script).not.toContain('cp "$desktop_root/MACOS_PREVIEW.md"');
    expect(script).toContain('Contents/Resources/icon.icns');
    expect(script).toContain('Print :CFBundleIconFile');
  });

  it('documente honnêtement le canal macOS inclus dans le lot updater', () => {
    const guide = readFileSync(
      new URL('../MACOS_UPDATER_PREVIEW.md', import.meta.url),
      'utf8',
    );

    expect(guide).toContain('canal de mise à jour intégré');
    expect(guide).toContain('signature Tauri/Ed25519');
    expect(guide).toContain('n’est pas notarié');
    expect(guide).not.toContain('canal de mise à jour signé reste volontairement désactivé');
    expect(guide).not.toContain('expirent après 14 jours');
  });

  it('embarque les icônes Zentra natives sur Windows et macOS', () => {
    const config = JSON.parse(
      readFileSync(
        new URL('../src-tauri/tauri.conf.json', import.meta.url),
        'utf8',
      ),
    ) as { bundle?: { icon?: string[] } };

    expect(config.bundle?.icon).toContain('icons/icon.ico');
    expect(config.bundle?.icon).toContain('icons/icon.icns');
  });
});
