# Fiche de salaire → assistant : isolation des fenêtres

29 septembre 2026. Correctif local **non distribué**, absent de la source figée de la version 1.90.9 en compilation. Aucun commit, push, CI, paquet natif ou accès de production exécuté par ce lot.

## Défaut reproduit

Depuis une fiche fictive, saisir `5123.45`, ouvrir l’assistant au clavier, puis demander une explication du contrat LPP. Avant correction, les deux fenêtres étaient exposées à l’arbre d’accessibilité et le champ de salaire situé derrière l’assistant acceptait un `focus()` programmatique. Le piège de tabulation et les retours de focus fonctionnaient déjà : ils ne sont pas présentés comme des défauts corrigés.

Preuves : [before.json](before.json), arbres `before-{edge,webkit}-{1440,320}-aria.yml` et captures correspondantes. Le cas est reproduit dans les quatre configurations, avec les fournisseurs et le moteur de réponse remplacés par le harness fictif existant. Le test bloque les requêtes hors localhost ; aucun domaine externe n’a été sollicité.

## Correction

`desktop/src/ui.tsx` maintient la pile des modales partagées. Après avoir placé le focus dans la fenêtre active, ses surfaces sœurs reçoivent `inert` et `aria-hidden`. À la fermeture, la couche précédente est réactivée avant de rétablir le focus ; la dernière fermeture restaure les attributs initiaux. Le style et le contenu des fenêtres restent inchangés.

Le test dédié est `desktop/tests/modal-assistant-accessibility.mjs`. Les seuls fichiers applicatifs modifiés par ce lot sont ce test et `desktop/src/ui.tsx`.

## Confirmation bornée

Une passe avant correction et une passe de confirmation, chacune Edge et WebKit à 1440 × 900 et 320 × 740. Pas de nouvelle campagne globale.

| Mesure | Avant, quatre configurations | Après, quatre configurations |
| --- | --- | --- |
| Fenêtres exposées comme dialogue | 2 | 1, Assistant Zentra |
| Fiche sous-jacente `inert` | Non | Oui |
| Focus programmatique vers le salaire derrière l’assistant | Accepté | Refusé |
| Échappées pendant 20 Tab + 20 Maj+Tab | 0 | 0 |
| Échap depuis l’assistant | Focus rendu à son bouton dans la fiche | Conservé |
| Échap depuis la fiche | Focus rendu à Nouvelle fiche | Conservé |
| Salaire après fermeture de l’assistant | `5123.45` | `5123.45` |
| Débordement horizontal de l’assistant / erreurs JavaScript | Aucun | Aucun |

La confirmation vérifie aussi le retour de la fiche dans l’arbre accessible, la restauration de l’application après fermeture et la conservation d’un élément déjà `inert` / `aria-hidden` avant ouverture. Les quatre captures finales ont été relues : composition et contrôles conservés.

Preuves : [after.json](after.json), arbres `after-{edge,webkit}-{1440,320}-aria.yml` et captures correspondantes. `node node_modules/typescript/bin/tsc --noEmit` et `git diff --check -- desktop/src/ui.tsx desktop/tests/modal-assistant-accessibility.mjs` réussissent.

Commandes du parcours, depuis `desktop/`, avec Vite local sur le port 5207 : `node tests/modal-assistant-accessibility.mjs --before` avant correction, puis `node tests/modal-assistant-accessibility.mjs` après correction. HEAD observé au terme du contrôle : `1acba4b9a8f7d436b6e452c8753e0bfd6bc02682`, avec le correctif en modifications locales.

## Limites

Tests navigateur avec clavier synthétique, arbre ARIA inspecté et tentative explicite de déplacement de focus. Aucun lecteur d’écran physique, NVDA, VoiceOver, TalkBack, clavier virtuel natif ou appareil physique testé. Aucun résultat de lecture vocale ni conformité globale n’est déduit. Le contrôle porte sur les modales partagées de ce parcours ; les autres systèmes de fenêtres et portails n’ont pas été recertifiés.
