# Zentra US — propagation collaborative en arrière-plan

9 octobre 2026. Base vérifiée propre `5ff83ece891f2456b38b45295136694f50ddf69f`. Phase B/C/F incrémentale ; pas de publication ni de migration hébergée autorisée dans ce jalon.

## Lacune constatée avant développement

Le serveur expose déjà `/erp/revision` et `/erp/changes` et valide/applique les événements US. Le navigateur charge seulement au montage, à la demande ou après sa propre commande : aucune boucle ne consomme ces API. Une modification distante ne fait donc pas avancer le workbench. Les propositions d'achat, rapprochements, profils vendeur/fiscal, équipe et réglages d'analyse ont des états indépendants du journal ERP ; un événement ERP seul ne suffit pas.

Les transports conservent les reprises exactes en RAM. Une lecture répétée de listes inchangées invalide des confirmations par numéro de lecture. Une actualisation fiscale peut aussi remplacer la révision de base tout en conservant des faits modifiés localement ; il faut préserver la base du brouillon et signaler le conflit, pas le convertir en écrasement autorisé.

## Contrat et réalisation prévue

- Une boucle par workbench visible, intervalle nominal trois secondes, single-flight et coalescence. Reprise immédiate à la reconnexion et au retour visible ; aucun POST automatique, aucune notification sonore, aucun panneau de chargement global. Backoff borné sur panne/429 ; annulation au démontage/changement d'identité.
- Consommer les deltas ERP existants après validation du scope, schéma, curseur et des montants ; construire un candidat privé avant application. Bornes de pages/taille/temps, refus des régressions de révision, relecture complète seulement lorsqu'un reset durable l'exige. Vérifier les générations de lecture, mutation et accès avant toute application.
- Endpoint privé US de têtes compactes, fermé par défaut avec Core/ERP US et sa gate de synchronisation. DTO version1 : espace, rôle vérifié, tête ERP éventuelle, jetons opaques de changement pour `supplierProposals`, `bankReconciliations`, `sellerProfile`, `taxProfile`, `team`, `supplierAnalysis`. `null` signifie canal non admis/configuré ; aucun fait fiscal, document, e-mail, lien d'invitation, secret ni grant dans ce DTO. Les profils privés restent réservés au propriétaire.
- Les jetons proviennent de l'état durable, avec lecture PostgreSQL groupée et bornée pour les états PG (y compris réglages et consommation d'analyse), et tête D1 pour l'équipe. L'admission et la provenance de l'abonnement Automation restent vérifiées dans D1. Un jeton est un indice de changement, jamais une autorité. Pas de hash de listes financières complètes transférées au navigateur chaque trois secondes.
- Rafraîchir uniquement les canaux dont la tête change. Conserver les instances et corps de reprise, les formulaires et le travail en cours. Différer/coalescer l'application pendant une mutation ou opération incertaine ; invalider une confirmation devenue obsolète sans effacer les valeurs saisies. Préserver la révision de base des brouillons privés.
- Chaque lecture exige les droits actuels du même espace, l'utilisateur attendu et une revalidation fraîche avant réponse. Perte d'accès/compte/rôle : purger les données visibles et arrêter la boucle. Ne pas reprendre le realtime legacy CH.

## Migrations et limites

Toute nouvelle fonction ou tête PostgreSQL passe par une migration additive créée avec le CLI local, testée avec le moteur PostgreSQL de test disponible et ses privilèges. RLS conservée, aucun droit public de lecture des têtes privées, aucun changement d'historique. Retour arrière logique : gate fermée et ancien code, données et reçus conservés. Aucune modification Supabase/D1/Stripe hébergée, ni compilation native distribuée.

Le jalon ne raccorde pas le prestataire fiscal null, ne crée pas de tarif live et ne rend pas une facture expérimentale certifiée. Un intervalle nominal ne garantit ni trois secondes de latence sous toute charge, ni une synchronisation en arrière-plan système sur iPhone fermé. Ces limites et les tests réellement exécutés doivent figurer dans la livraison à huit rubriques.

## Recette attendue

Deux transports/UI sur le même espace : création, encaissement et mise à jour à distance sans clic ; absence de plein GET ERP à tête stable ; nouveaux états indépendants du journal ; récupération paginée/reconnexion ; réponse tardive, accès révoqué, autre compte/espace, schéma supérieur et malformed delta ; aucune application partielle ; aucun POST/retry inventé ; brouillons/confirmations et opérations incertaines préservés ; clair/sombre, quatre langues et mobile. TypeScript, lint pertinent, build, tests locaux des migrations et compatibilité CH. Les tentatives Windows workerd bloquées sont rapportées comme telles.

Sources : [visibilité d'une page](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API), [appel RPC Supabase](https://supabase.com/docs/reference/javascript/rpc). Les APIs existantes restent la référence du protocole Zentra ; ces documents ne sont pas une preuve d'exécution hébergée.
