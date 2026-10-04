import { t } from './language';

/** Translate authored operation messages at display time; captured file names stay verbatim. */
export function projectFileMessageText(source: string): string {
  const document = /^Document (\d+)\/(\d+) : ([\s\S]+)$/.exec(source);
  if (document) return t('Document {index}/{total} : {name}', { index: document[1], total: document[2], name: document[3] });
  const adding = /^Ajout (\d+)\/(\d+) · ([\s\S]+)$/.exec(source);
  if (adding) return t('Ajout {index}/{total} · {name}', { index: adding[1], total: adding[2], name: adding[3] });
  const opening = /^Ouverture de ([\s\S]+)…$/.exec(source);
  if (opening) return t('Ouverture de {name}…', { name: opening[1] });
  const saved = /^(\d+) fichiers? enregistrés? sur cet appareil\.( Seuls les fichiers ci-dessous restent à ajouter\.)?( L’ajout est en pause tant que l’application est en lecture seule\.)?$/.exec(source);
  if (saved) return t(Number(saved[1]) === 1 ? '{count} fichier enregistré sur cet appareil.' : '{count} fichiers enregistrés sur cet appareil.', { count: saved[1] })
    + (saved[2] ? t(saved[2]) : '') + (saved[3] ? t(saved[3]) : '');
  const paused = ' L’ajout est en pause tant que l’application est en lecture seule.';
  if (source === 'Les fichiers sélectionnés restent à ajouter.' + paused)
    return t('Les fichiers sélectionnés restent à ajouter.') + t(paused);
  for (const [pattern, message] of [
    [/^([\s\S]+) est vide\.$/, '{name} est vide.'],
    [/^([\s\S]+) dépasse 25 Mo\.$/, '{name} dépasse 25 Mo.'],
    [/^Le format de ([\s\S]+) n’est pas pris en charge\.$/, 'Le format de {name} n’est pas pris en charge.'],
    [/^Impossible de lire ([\s\S]+)\.$/, 'Impossible de lire {name}.'],
  ] as const) {
    const match = pattern.exec(source);
    if (match) return t(message, { name: match[1] });
  }
  return t(source);
}
