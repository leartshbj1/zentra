import { afterEach, describe, expect, it, vi } from 'vitest';
import { payrollAiImageBlobFromDataUrl } from './payrollAiImageSource';

describe('préparation locale des images pour SmolVLM', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('décode une URL data en Blob sans requête réseau', async () => {
    const fetch = vi.fn(() => Promise.reject(new Error('CSP connect-src')));
    vi.stubGlobal('fetch', fetch);

    const blob = payrollAiImageBlobFromDataUrl('data:image/jpeg;base64,AAECAwQ=');

    expect(fetch).not.toHaveBeenCalled();
    expect(blob.type).toBe('image/jpeg');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([0, 1, 2, 3, 4]);
  });

  it('refuse une URL distante ou un type qui ne vient pas du rendu local', () => {
    expect(() => payrollAiImageBlobFromDataUrl('https://example.test/fiche.jpg'))
      .toThrow('document local');
    expect(() => payrollAiImageBlobFromDataUrl('data:text/html;base64,PGgxPk5vbjwvaDE+'))
      .toThrow('format');
  });

  it('explique une image locale corrompue', () => {
    expect(() => payrollAiImageBlobFromDataUrl('data:image/png;base64,%%%'))
      .toThrow('illisible');
  });
});
