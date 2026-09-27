# Clients et projets — affichage par pages

27 septembre 2026. Lot de l’audit premier client, préparé à partir de `2174c3a4` sur `codex/first-client-native-20260927`. Il concerne la source de Gestion, pas les installateurs 1.90.3 déjà distribués.

## Problème mesuré

L’annuaire rendait toutes les lignes et parcourait à nouveau les projets pour le compteur de chaque client. La liste de projets cherchait le client plusieurs fois par carte et calculait les indicateurs de tous les dossiers, même hors écran. Avec 2 200 clients dont 200 archivés, 2 000 projets et 4 000 factures fictives, cela produisait entre 58 366 et 128 380 éléments DOM.

Le scénario local mesure le délai entre le clic de navigation et deux frames après l’apparition de la liste. Il conserve également les durées du Profiler React. Un seul échantillon par configuration : ces chiffres montrent le problème et le résultat dans cette recette de développement, sans valoir mesure de production ou sur iPhone physique.

| Moteur / largeur | Écran | Avant | Après | Lignes/cartes montées après |
| --- | --- | ---: | ---: | ---: |
| Edge, 1440 px | Clients | 1 843 ms | 113 ms | 25 |
| Edge, 1440 px | Projets | 4 245 ms | 81 ms | 12 |
| Edge, 390 px | Clients | 4 781 ms | 146 ms | 25 |
| Edge, 390 px | Projets | 5 171 ms | 96 ms | 12 |
| WebKit, 390 px | Clients | 6 300 ms | 142 ms | 25 |
| WebKit, 390 px | Projets | 8 929 ms | 112 ms | 12 |

Le DOM des écrans mesurés contient ensuite 1 096 à 1 169 éléments. Le rendu React passe d’environ 482–1 960 ms à 15–35 ms dans ces mêmes configurations.

## Fonctionnement livré dans la source

- Clients : 25 fiches par page, actifs et archives séparés comme auparavant. Les compteurs portent sur tout l’annuaire.
- Projets : 12 dossiers par page, recherche par projet ou client et filtre d’état appliqués avant le découpage. Les chiffres d’un projet sont toujours calculés avec toutes ses données métier.
- Les index de clients et de nombre de projets évitent les recherches répétées dans chaque ligne. Les calculs des cartes ne sont exécutés que pour les dossiers visibles.
- Les contrôles Précédent/Suivant sont accessibles en haut et en bas de liste. Sur téléphone, les chevrons gardent des noms accessibles complets et une cible d’au moins 44 px. Le compteur supérieur annonce la plage affichée.
- Un nouveau filtre revient au début. Une réduction des données par synchronisation ramène à une page valide et la page abandonnée ne réapparaît pas lorsque la liste grandit ensuite.
- Le changement de page ramène le défilement et le focus au début de la liste. L’ouverture d’un dossier conserve la recherche. La lecture seule continue d’autoriser la navigation, mais pas les modifications.
- Le titre de colonne Projets de l’annuaire est traduit, comme les nouveaux contrôles, en français, allemand, italien et anglais. Les noms et adresses saisis ne sont pas traduits.

Le découpage est uniquement un choix d’affichage : il ne supprime aucune donnée, ne limite ni la recherche ni les compteurs, et ne change pas les contrats de synchronisation, de sauvegarde ou de comptabilité. Le chargement du Workspace complet depuis le moteur natif reste inchangé.

## Vérifications

- 1 749 tests frontend / 218 fichiers réussis après l’implémentation. La correction finale du titre traduit est ensuite validée par TypeScript, build et parcours multilingues.
- Contrôle des 50 actifs de marque et compilation Vite réussis. L’avertissement préexistant sur de gros modules JavaScript demeure.
- 12 parcours Edge/WebKit : 1440/768/390/320 px, quatre langues, clair/sombre. Recherche de l’élément 1999, page suivante au clavier, ouverture/retour de dossier, archives, état du projet, actualisation avec liste réduite puis agrandie, recherche vide, cibles de navigation conservées en lecture seule. Aucun débordement horizontal ni exception JavaScript dans ces parcours.
- Un seul passage du détecteur Impeccable sur les fichiers d’interface modifiés : aucune alerte. Cela ne constitue pas un audit complet d’accessibilité.
- Captures de viewport : 12 écrans plus quatre états de lecture seule. Les captures longues intermédiaires, trop réduites pour être lisibles, ont été remplacées par ces vues utilisables.

Preuves : `desktop/.qa/large-directories/before/proof.json`, `after/proof.json`, `tests.log`, `build.log`, `detector.json`. Recette reproductible : `desktop/tests/large-directories.mjs`, avec `ZENTRA_QA_STAGE=before|after`, `ZENTRA_QA_ORIGIN` et `ZENTRA_PLAYWRIGHT_MODULE`. Les parcours utilisent le vrai frontend mais des données et un pont natif fictifs ; aucun service extérieur n’est appelé.

## Limites

Revue de finition indépendante : `ship`, aucune correction matérielle demandée dans ce lot. La documentation a été vérifiée dans une seconde passe indépendante ; PRODUCT.md, DESIGN.md et les tokens sont conservés. Voir `desktop/.qa/large-directories/documentation-review.md` et `desktop/.impeccable/surfaces/directory-performance.md`. Ces deux revues ne valent pas validation d’une installation native.

La publication native, le ressenti sur appareils physiques, les grandes listes des autres modules, l’accessibilité avec lecteur d’écran et la charge serveur à 150 entreprises restent à vérifier séparément. Ce lot n’agit pas sur la restriction actuelle du service de compte Supabase. La refonte générale et l’ensemble des points de l’audit ne sont pas déclarés terminés.
