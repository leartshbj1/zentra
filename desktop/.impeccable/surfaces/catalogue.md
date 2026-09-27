# Catalogue — Operate

Extension code-led du monde précision calme. Le client doit retrouver un article, son prix et son stock puis agir sans traverser des statistiques et filtres ouverts en permanence.

Conserver la typographie système, les couleurs sémantiques clair/sombre, les permissions et les données métier. Pas de nouvelle palette, image ou animation.

Premier écran : titre de page unique, création et import, résumé repliable, recherche/filtres à la demande, premiers articles. Les alertes de stock restent visibles. Afficher les filtres actifs et permettre leur remise à zéro. Pagination après filtrage de 20 articles avec les totaux de l'ensemble ; ne pas limiter la recherche à la page visible.

Interface et historique traduits FR/DE/IT/EN ; valeurs de quantités selon la langue. Noms, descriptions, unités, références et motifs saisis par l'utilisateur conservés exactement. Conserver prix, coûts, quantités présentes/réservées/disponibles, archivage, mouvements et historique.

Vérifier composants réels dans le harnais sur Edge/WebKit, téléphone et bureau, clair/sombre, texte agrandi, filtres et permissions. Les captures ne prouvent pas un iPhone physique ni la persistance native. Les formulaires d'édition et d'import ont un périmètre de traduction distinct qui reste à examiner.

## Direction contract

**THESIS:** Retrouver une référence et agir sur son stock ; les statistiques et filtres permanents ne dominent pas la liste.

**OWN-WORLD:** Extension de précision calme : feuille opaque, séparateurs, typographie système et vert sémantique des thèmes existants. Aucun token global ni raster ajouté.

**STORY:** Lire l'identité, le prix et les quantités, rechercher au besoin, puis modifier ou ouvrir mouvements et historique selon les permissions. La divulgation des filtres est l'interaction structurante ; aucune animation ajoutée.

**FIRST VIEWPORT:** Sous le titre unique, création principale et import secondaire, résumé fermé, alerte de stock éventuelle, compteur et commande de recherche, pagination et premières lignes. Sur téléphone, actions d'en-tête en deux colonnes ; en texte agrandi, actions d'en-tête et d'article empilées à pleine largeur.

**FORM:** Feuille de liste existante, extension ordinaire code-led. Classement de concepts et seed non applicables ; aucun nouveau monde visuel.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Comportement réalisé

La recherche globale est exclue de cette destination dans WorkspaceApp. La recherche locale, le type et l'état filtrent et trient toute la collection avant le découpage en pages de 20. Le compteur et les deux paginations, avant et après la liste, portent sur tous les résultats filtrés ; les paginations disparaissent avec une seule page. Le résumé et l'alerte portent sur l'ensemble des références actives, indépendamment des filtres. Modifier un filtre ramène à la première page ; une collection réduite borne durablement la page. Changer de page ramène le focus au début de la liste.

Les actions de liste conservent une cible mobile d'au moins 44 px. À 150/175/200 % sous 861 px, les groupes de modification/archivage et de mouvements occupent toute la largeur, avec boutons empilés et mots entiers. Le texte garde la taille choisie. Les valeurs métier et les gardes de lecture seule ou d'opération en cours restent inchangées ; une sortie est désactivée si le disponible est nul ou négatif.

L'interface de liste et les libellés d'historique suivent FR/DE/IT/EN. Les quantités utilisent la locale courante avec trois décimales, sans changer leur valeur ; les contenus utilisateur restent verbatim. La traduction et la validation des formulaires d'édition, d'import et de mouvements gardent un périmètre distinct à examiner.

## Clôture et preuves

Le [verdict indépendant](../review/catalogue/finish-review.md) conclut **ship** pour ce frontend : unique P2 sur les actions agrandies résolu, confirmation limitée à cette correction. Les [preuves documentées](../review/catalogue/documentation.md) couvrent les 11 états du harnais et les limites à 3 001 articles. Aucun raster n'est livré ; les captures servent uniquement à la QA. DESIGN.md, PRODUCT.md et design.json sont préservés. Cette clôture ne certifie ni l'application complète, ni la persistance/synchronisation native, ni un appareil physique.
