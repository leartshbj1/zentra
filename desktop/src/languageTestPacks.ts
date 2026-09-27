import { beforeAll } from 'vitest';
import { translations } from './translations';
import { setAppLanguage } from './language';
import { languageAssets } from 'virtual:zentra-language-assets';

// Vitest has no asset server. Exercise the same JSON loader with the authored pack contents.
beforeAll(async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async input => {
    const index = ['de', 'it', 'en'].findIndex(language => languageAssets[language as keyof typeof languageAssets] === String(input));
    if (index < 0) throw new Error('Unexpected language asset URL');
    return new Response(JSON.stringify(Object.fromEntries(Object.entries(translations).map(([key, values]) => [key, values[index]]))));
  };
  try { for (const language of ['de', 'it', 'en', 'fr'] as const) await setAppLanguage(language); }
  finally { globalThis.fetch = original; }
});
