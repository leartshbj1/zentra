import type { Plugin } from 'vite';
import { translations } from '../src/translations';

// Source dictionaries remain editable together; only the selected JSON is read at runtime.
export function localLanguageAssets(): Plugin {
  const ids = ['de', 'it', 'en'] as const;
  const packs = Object.fromEntries(ids.map((language, index) => [language,
    JSON.stringify(Object.fromEntries(Object.entries(translations).map(([key, values]) => [key, values[index]]))),
  ]));
  const prefix = '/__zentra-language/';
  let building = false;
  return {
    name: 'zentra-local-languages',
    configResolved(config) { building = config.command === 'build'; },
    resolveId(id) { if (id === 'virtual:zentra-language-assets' || id === 'virtual:zentra-language-keys') return '\0' + id; },
    load(id) {
      if (id === '\0virtual:zentra-language-keys') return `export const interfaceKeys = new Set(${JSON.stringify(Object.keys(translations))});`;
      if (id !== '\0virtual:zentra-language-assets') return;
      return `export const languageAssets = {${ids.map(language => {
        const url = building
          ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: 'asset', name: `language-${language}.json`, source: packs[language] })}`
          : JSON.stringify(prefix + language + '.json');
        return `${language}: ${url}`;
      }).join(',')}};`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const file = req.url?.split('?')[0];
        const language = ids.find(id => file === prefix + id + '.json');
        if (!language) return next();
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(packs[language]);
      });
    },
  };
}
