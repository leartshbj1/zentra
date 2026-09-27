# Catalogue : lisibilité et grandes listes

27 septembre 2026. Source `493c6033`, postérieure aux fichiers publiés 1.90.4. Ce document décrit le code vérifié, pas un nouvel installateur livré.

Le catalogue rempli n’affiche plus deux titres ni deux recherches. Le résumé et les filtres se déplient au besoin ; l’alerte de stock reste visible. Vingt articles sont rendus à la fois, après recherche, filtre et tri de toute la collection. Les totaux portent sur l’ensemble approprié. Une actualisation qui réduit la collection ramène durablement la pagination dans les limites ; le retour d’articles ne rétablit pas une ancienne page.

Les libellés de liste et d’historique sont traduits en allemand, italien et anglais. Les quantités suivent la langue, sans modifier les valeurs entières stockées. Les noms, références, descriptions, unités et motifs saisis restent inchangés. Les formulaires d’édition, de mouvements et d’import ne sont pas certifiés entièrement traduits par ce lot.

Sur mobile, les boutons gardent des cibles de 44 px. Les quantités sont présentées sur des lignes alignées. Avec le texte à 150/175/200 %, les actions d’article et de mouvements utilisent toute la largeur et s’empilent sans découper les mots.

## Vérification

- 15 tests unitaires catalogue et pagination réussis ; contrôle TypeScript et compilation web complète réussis. L’avertissement existant sur le module Excel reste présent.
- 11 parcours de composants réels dans le harnais : WebKit FR/DE/IT/EN à 390 px sombre et 1440 px clair, Edge 390 px clair et 1440 px sombre, WebKit allemand à 320 px et texte 200 %. Recherche sur les pages suivantes, remise à zéro, archives, historique, lecture seule et absence de débordement horizontal vérifiés.
- Deux parcours supplémentaires Edge et WebKit avec 3 001 articles fictifs : 20 articles rendus, recherche du dernier article, alerte visible avec résumé fermé, sortie interdite pour stock négatif, réduction puis réaugmentation de la liste, focus clavier et reprise après recherche vide. Dans cette exécution locale, ouverture mesurée à 153–270 ms et recherche à 39–43 ms. Aucun avant/après ni résultat sur appareil client ou charge serveur n’en est déduit.
- Revue indépendante : un P2 sur les actions à texte agrandi a été corrigé puis jugé résolu, disposition `ship` à cette portée. Documentation de surface terminée ; PRODUCT.md, DESIGN.md et design.json inchangés.

Preuves locales : `desktop/.impeccable/review/catalogue/` (captures, résultats, revue, documentation), `outputs/catalog-tests.log`, `outputs/catalog-collection-boundaries.log`, `outputs/catalog-web-build.log`.

Le pont natif et les données sont fictifs dans ces essais. Cela ne valide ni appareil physique, ni persistance, ni synchronisation de production.
