# Clients et Projets — grandes listes

Mode : Operate. Extension du contrat [workspace](workspace.md), dans le monde existant « précision calme », réalisée dans le code. Ce document décrit uniquement les annuaires Clients et Projets ; PRODUCT.md et DESIGN.md restent les autorités produit et visuelle.

## Intention

Retrouver et ouvrir un client ou un projet dans un grand annuaire sans monter toute la collection à l'écran. Conserver les listes, les fiches, les états et les opérations métier existants.

## Comportement local

- La recherche et les filtres portent sur la collection complète avant son découpage. Dans Clients, actifs et archives restent des vues distinctes ; dans Projets, le filtre d'état et la recherche par projet ou client sont conservés.
- Afficher 25 clients ou 12 projets par page. Les compteurs restent complets et les indicateurs d'une carte projet utilisent toutes ses données métier.
- Présenter les commandes Précédent/Suivant en haut et en bas lorsque plusieurs pages existent. Montrer la plage et le total ; seule la plage du haut annonce les changements.
- Revenir à la première page après modification du filtre. Après réduction de la collection, conserver une page valide et ne pas ressusciter l'ancienne page si la collection grandit.
- Au changement de page, ramener le défilement et le focus au début du groupe de liste. Conserver la navigation en lecture seule avec les restrictions de mutation existantes.

## Présentation et accessibilité

Réemployer les boutons secondaires et les rôles de couleur du système, les chiffres tabulaires et le focus d'accent. Conserver une cible de navigation d'au moins 44 × 44 px. Sous 540 px, masquer les mots Précédent/Suivant tout en gardant les chevrons et leurs noms accessibles complets ; laisser la plage centrale se réorganiser selon sa longueur.

Les nouveaux libellés de navigation, de groupe et de plage ainsi que le titre Projets de l'annuaire utilisent le système de traduction français, allemand, italien et anglais. Les noms et adresses saisis restent des données utilisateur. Cette extension n'ajoute ni animation ni token global ; les thèmes et les adaptations mobiles restent ceux de la surface existante.

## Sources et vérification

Implémentation : src/CollectionPagination.tsx, src/collection-pagination.css, écrans Clients/Projets de src/WorkspaceApp.tsx et src/translationsFirstClientClarity.ts.

Les [mesures et parcours](../../../docs/LISTES-VOLUMINEUSES-20260927.md) et la [relecture documentaire](../../.qa/large-directories/documentation-review.md) précisent les preuves. Le dossier ../review/large-directories contient 16 captures et proof.json ; le reviewer indépendant a conclu « ship » sans correction matérielle dans le périmètre examiné.

Source locale non publiée, données synthétiques et pont natif fictif. Aucun aperçu navigateur ou verdict documentaire ne vaut recette sur appareil physique, livraison native, contrôle de charge serveur ou validation de toutes les autres listes de Gestion.
