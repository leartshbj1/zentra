import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('migration Windows Elyko vers Zentra', () => {
  const tauri = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
  ) as {
    productName: string;
    mainBinaryName: string;
    identifier: string;
    bundle: { windows: { nsis: { installerHooks?: string } } };
  };
  const hooks = readFileSync(
    new URL('../src-tauri/installer-hooks.nsh', import.meta.url),
    'utf8',
  );

  it('affiche Zentra sans changer l’identité qui porte les données locales', () => {
    expect(tauri.productName).toBe('Zentra');
    expect(tauri.mainBinaryName).toBe('Zentra');
    expect(tauri.identifier).toBe('ch.helvichantier.desktop');
    expect(tauri.bundle.windows.nsis.installerHooks).toBe('installer-hooks.nsh');
  });

  it('ne migre que le chemin Elyko historique exact', () => {
    expect(hooks).toContain('ReadRegStr $R8 HKCU "Software\\Elyko\\Elyko"');
    expect(hooks).toContain('${If} $R8 == "$LOCALAPPDATA\\Elyko"');
    expect(hooks).toContain('${AndIf} ${FileExists} "$R8\\Elyko.exe"');
    expect(hooks).toContain('StrCpy $INSTDIR "$R8"');
    expect(hooks).toContain('SetOutPath "$INSTDIR"');
  });

  it('remplace le binaire et les raccourcis sans toucher au profil SQLite', () => {
    expect(hooks).toContain('CheckIfAppIsRunning "Elyko.exe"');
    expect(hooks).toContain('Delete "$INSTDIR\\Elyko.exe"');
    expect(hooks).toContain('CreateShortcut "$SMPROGRAMS\\Zentra.lnk"');
    expect(hooks).toContain('CreateShortcut "$DESKTOP\\Zentra.lnk"');
    expect(hooks).toContain(
      'DeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Elyko"',
    );
    expect(hooks).not.toContain('RmDir /r "$LOCALAPPDATA\\ch.helvichantier.desktop"');
    expect(hooks).not.toContain('helvichantier.sqlite3');
  });
});
