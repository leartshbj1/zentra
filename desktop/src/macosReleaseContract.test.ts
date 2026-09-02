import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const previewConfigUrl = new URL(
  '../src-tauri/tauri.macos.preview.conf.json',
  import.meta.url,
);
const workflowUrl = new URL(
  '../../.github/workflows/macos-preview.yml',
  import.meta.url,
);
const buildScriptUrl = new URL(
  '../scripts/build-macos-preview.sh',
  import.meta.url,
);

describe('macOS private preview release contract', () => {
  it('builds a universal ad-hoc app and DMG without updater secrets', () => {
    const config = JSON.parse(readFileSync(previewConfigUrl, 'utf8')) as {
      identifier: string;
      bundle: {
        targets: string[];
        createUpdaterArtifacts: boolean;
        macOS: { minimumSystemVersion: string; signingIdentity: string };
      };
    };

    expect(config.identifier).toBe('ch.zentra.desktop');
    expect(config.bundle.targets).toEqual(['app', 'dmg']);
    expect(config.bundle.createUpdaterArtifacts).toBe(false);
    expect(config.bundle.macOS.minimumSystemVersion).toBe('12.0');
    expect(config.bundle.macOS.signingIdentity).toBe('-');
  });

  it('runs on GitHub macOS and keeps the preview out of releases', () => {
    const workflow = readFileSync(workflowUrl, 'utf8');
    const script = readFileSync(buildScriptUrl, 'utf8');

    expect(workflow).toContain('runs-on: macos-14');
    expect(workflow).toContain('pnpm --dir desktop build:macos:preview');
    expect(workflow).toContain(
      'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain(
      'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    );
    const actionReferences = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(
      (match) => match[1],
    );
    expect(actionReferences.length).toBeGreaterThan(0);
    expect(
      actionReferences.every((value) => /@[0-9a-f]{40}$/.test(value)),
    ).toBe(true);
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).not.toContain('secrets.');
    expect(workflow).not.toContain('softprops/action-gh-release');
    expect(script).toContain('--target universal-apple-darwin');
    expect(script).toContain('codesign --verify --deep --strict');
    expect(script).toContain('SHA256SUMS.txt');
    expect(script).toContain('LISEZ-MOI-macOS.md');
    expect(script).not.toContain('-maxdepth');
  });
});
