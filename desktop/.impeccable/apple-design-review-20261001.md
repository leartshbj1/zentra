# Revue finale Apple — 1er octobre 2026

**Verdict indépendant : ship**, pour le frontend examiné par `apple_finish_review` après les corrections d’en-têtes, de contenus chargés, du saut vers les prestations et du dock. Périmètre : application React/Tauri, bureau/mobile et thèmes clair/sombre ; site public et backend exclus.

La refonte utilise cinq couches écran Apple, des feuilles opaques, des listes métier, une police système et les verts Zentra. Le tiroir suit le geste et transmet sa vitesse à un ressort critique ; les sélections X/Y sont mesurées et interruptibles. Le réglage de texte 100–200 %, les fonctions, validations, droits et documents sont conservés. [DESIGN.md](../DESIGN.md) et [design.json](design.json) décrivent les valeurs réellement extraites : 30 couleurs, dix composants, schema v2.

Preuves locales finales :

- [Build complet](../outputs/apple-redesign/build-final.txt) réussi via quatre commandes Node successives avec arrêt à l’erreur : `check-brand-icons.mjs` (50 sorties), `build-dark-palette.mjs` (98 feuilles), `tsc --noEmit`, puis `vite.js build`. Palettes Apple exclues du générateur sombre.
- [Vitest](../outputs/apple-redesign/tests-final.txt) : 232 fichiers, 1 917 tests réussis, 1 skip préexistant ; 12 nouveaux tests de ressort inclus.
- [Edge](../outputs/apple-redesign/matrix-chromium/report.json) : 18 menus × 2 thèmes × 4 langues × 2 largeurs (390/1440), soit 288 cas chargés, zéro issue. [WebKit](../outputs/apple-redesign/matrix-webkit/report.json) : 72 cas FR, zéro issue.
- [Réglages](../outputs/apple-redesign/settings-chromium/report.json) : 135 contrôles des 15 catégories, dont 320/DE/200 % ; aucun dernier contrôle couvert.
- [Formulaires](../.qa/forms/report.json) : 7 créations et 5 sections Achats à 5 largeurs, confinement clavier confirmé. [Éditeur documentaire](../.qa/document-wizard-edge/report.json) : quatre contextes, brouillon, client rapide, acompte, avoir EUR et lecture seule réussis.
- [Mouvement/focus](../.qa/navigation-motion/report.json) : Edge/WebKit réussis, reprise, inversion, annulation, re-mesure, focus restitué et mouvement réduit. Souris vérifiée dans Edge.
- [Détecteur unique](../outputs/apple-redesign/detector.json) : exit 0, aucun blocage, 15 advisories palette/rayon sur ombres alpha et rayons locaux/hérités. Résultat conservé ; aucun nouveau scan documentaire.

Rapports et captures QA restent locaux, ignorés par Git ; aucun nouveau raster décoratif livré. Les essais utilisent des fixtures : ils ne certifient pas chaque état métier ou intégration serveur. Le papier et l’impression gardent leurs règles ; aucune comparaison exhaustive de PDF n’est revendiquée. Le CSS observé (environ 1.793 MB, 163 KB gzip) n’est pas un benchmark de performance. Aucune publication native ni validation matérielle iOS/macOS. Le réglage web ne prouve pas Dynamic Type natif ; aucune variante dédiée de contraste renforcé n’est ajoutée.
