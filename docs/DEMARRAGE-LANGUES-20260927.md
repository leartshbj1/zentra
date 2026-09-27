# Démarrage — charger uniquement la langue choisie

Lot du 27 septembre 2026, préparé après le gel des installateurs 1.90.3. Base : `406d7ec3`, branche `codex/first-client-native-20260927`. Ce document décrit une correction de source et sa validation locale, pas une publication native.

## Changement

Le catalogue réunissant les trois traductions n’est plus importé par le code exécuté au démarrage. Vite produit trois fichiers JSON locaux, à noms versionnés par leur contenu ; ils font tous partie de `dist`, le dossier complet embarqué par Tauri. Le français utilise les textes sources. Les messages de paie et d’achats utilisent un ensemble exact de clés connues au lieu d’importer toutes leurs traductions.

L’app attend la langue enregistrée avant de monter son interface. Les changements en cours de session conservent les formulaires ; le choix n’est publié et mémorisé qu’une fois son fichier lu. Les lectures simultanées sont regroupées, les fichiers réussis conservés en mémoire, et le dernier choix gagne même si une ancienne lecture termine après lui. Une erreur garde la langue précédente, offre « Réessayer », et expire après 12 secondes en cas de lecture bloquée. Au démarrage, continuer explicitement en français reste possible. Les messages de reprise sont disponibles dans les quatre langues indépendamment des fichiers.

L’API interne `setAppLanguage` est désormais asynchrone. Les réglages, l’accueil de configuration, les tests et les entrées de recette attendent son résultat. Les préférences venant d’une autre fenêtre suivent la même règle sans écriture en retour.

## Mesure et compromis

| Graphe JavaScript statique depuis index.html | Avant | Après |
| --- | ---: | ---: |
| Octets bruts | 1 469 527 | 681 717 |
| Octets gzip, mesure locale | 466 449 | 216 350 |

Réduction d’environ **54 % du JavaScript initial**. Cette mesure exclut le module principal de l’espace, les modules différés, les CSS, l’IPC et les fichiers JSON lus ensuite. Une langue autre que le français ajoute un fichier : allemand 406 119 octets, anglais 377 062, italien 396 761, chacun avec 3 895 messages. Le gain brut entrée + fichier choisi est donc d’environ 26–28 % pour ces langues. Les trois JSON pèsent ensemble environ 1,18 Mo dans l’installation ; les clés répétées augmentent le stockage total par rapport au catalogue unique. Le gain visé est le chargement et l’analyse de code au démarrage, pas une réduction de l’installateur.

Le contrôle élargi entrée + espace de travail relève encore **1 610 067 octets JS**, 71 modules, et 167 actifs locaux vérifiés. L’avertissement Vite relatif aux gros modules persiste. Aucun temps de démarrage réel sur appareil ni amélioration du service de connexion n’est déduit de ces chiffres.

## Vérifications

- TypeScript, contrôle des 50 actifs de marque et build Vite de production réussis, avec contrôle de présence des dépendances et actifs différés. Le frontend natif reste `../dist`.
- Suite frontend finale : **1 749 tests réussis dans 218 fichiers**. Ce total comprend les 16 tests spécifiques au chargement différé des langues.
- Tests dédiés : choix valide, démarrage dans la langue mémorisée, regroupement des lectures, cache, ordre des requêtes, reprise après échec et expiration, stockage indisponible, changement interfenêtres, données JSON invalides, conservation des paramètres et des messages natifs connus.
- 12 cas navigateur Edge/Chromium et WebKit : 320 px clair, 390 px sombre, 1440 px clair, état d’erreur et reprise, absence de débordement, premier rendu DE/EN, et saisie conservée dans le vrai formulaire d’entreprise. Données fictives et aucun compte réel.
- 4 contrôles complémentaires : JSON de production servi dans la recette, déconnexion du navigateur et reprise sans perdre le brouillon, puis erreur de démarrage/reprise dans les deux moteurs. Le comportement des routes interceptées hors ligne diffère entre moteurs. **Le fonctionnement hors ligne de Tauri sur appareil physique n’est pas validé par cette simulation.**
- Revue visuelle indépendante : `ship` pour les 20 captures principales, puis `ship` pour les deux états de démarrage sombre à 390 px. Le complément documentaire a conduit à faire précéder `env()` par les marges natives `--safe-*`. Le contrôle de padding 80/44/60/44 px et les deux nouvelles captures sont réussis ; la revue a noté cette correction « résolue ». Aucun constat de disponibilité globale de l’app.

Preuves locales dans `desktop/.qa/language-loading/` : `entry-before.json`, `entry-after.json`, `tests.log`, `loading-tests.log`, `build.log`, `packaged-assets.json`, `browser-proof.json`, `packaging-proof.json`, `finish-review.md`, `documentation-review.md` et `screens/`. Scripts reproductibles : `desktop/tests/language-loading.mjs`, `language-packaging.mjs` ; module Playwright via `ZENTRA_PLAYWRIGHT_MODULE`, origine via `ZENTRA_QA_ORIGIN` pour le premier script.

## Limites de livraison

Les installateurs 1.90.3 déjà publiés n’incluent pas ce lot. Aucun canal de mise à jour, compte, facture, e-mail ou abonnement n’a été modifié ici. La connexion réelle relevée lors de l’audit de 09:48:53 en Suisse renvoyait HTTP 503 ; sa disponibilité n’a pas été revérifiée par ce lot. Les tests multiappareils réels, le rétablissement du service de comptes et les validations de distribution restent ouverts dans le suivi général.

Identité conservée : Operate / « Précision calme », palette et thèmes existants, messages près du contrôle concerné, boutons tactiles et marges de sécurité. `PRODUCT.md`, `DESIGN.md` et le fichier de tokens ne sont pas modifiés. Le détecteur unique a signalé des avis hérités de `language.css` et un nouveau repli de couleur, remplacé par les variables existantes avant les captures finales ; aucun second passage du détecteur.
