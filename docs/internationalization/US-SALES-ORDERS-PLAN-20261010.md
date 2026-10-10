# Commandes clients US — plan incrémental

Base locale `ea4613b`. L'audit initial et l'état des phases ont été relus avant cette modification. Cette verticale de la phase C complète le cycle commercial, sans prétendre livrer les acomptes, avoirs, récurrences, livraisons ou encaissements bancaires. Les versions CH, le protocole ERP 1–4, les données clientes et la production restent préservés.

## Résultat visé

Depuis un devis accepté, créer une commande numérotée avec une copie exacte du devis, de son client et de sa révision. La confirmer ou l'annuler explicitement, conserver auteur/date/référence/audit et permettre à l'équipe de consulter le même document. La confirmation est interne ; elle ne certifie pas à elle seule l'accord contractuel du client. Une commande non annulée protège son devis contre une modification silencieuse. Une facture existante issue de cette source rend la commande facturée dans la projection ; ce lien est corroboré, jamais une émission inventée.

Le document présente le montant commercial hors taxe et une taxe à déterminer. La commande ne déclenche aucun journal, paiement, livraison ou calcul fiscal. L'accès au parcours de facturation existant reste soumis à ses propres droits et à une détermination fiscale actuelle. Annuler ne supprime pas une facture, un paiement ou une écriture.

## Architecture choisie

Registre commercial PostgreSQL additif, lié à l'entreprise et au livre ERP réel : commandes, tête/compteur, reçus idempotents et audit. Aucun nouveau format ERP partagé n'est injecté dans un ancien client. Les RPC privés `security invoker`, RLS et permissions minimales préservent l'isolation ; le serveur relit l'admission D1/Auth/Gestion avant et après les attentes. Les mises à jour de commande verrouillent la tête ERP puis la tête commerciale dans un ordre cohérent ; révisions et reçus exacts refusent les courses et les doubles créations. Un trigger additif protège la source et les liens lors des écritures ERP existantes. Aucune migration antérieure n'est réécrite.

Lectures paginées et détail explicite, sans plafond de nombre de commandes sur la durée de vie de l'entreprise. Une page contient au plus 25 commandes, avec curseur de séquence stable. Une lecture de tête compacte fournit les révisions commerciale et ERP ; la recherche d'une source par `estimateId` est indépendante de la page visible. Elle retourne le statut réel du devis, sa révision, l'éventuelle commande active et l'éventuelle facture, sans charger le livre ERP complet. Les tailles des messages, pages, lignes et documents restent bornées. L'interface FR/EN/DE/IT réutilise le workbench, les thèmes et les composants de documents ; les commandes restent disponibles sans abonnement Automation.

## Activation et garde de l'historique

Deux flags serveur stricts, absents ou faux par défaut, séparent l'ouverture de nouvelles opérations et la conservation d'un historique utilisable :

- `INTERNATIONAL_US_SALES_ORDERS_ENABLED` : création et confirmation de nouvelles commandes.
- `INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED` : consultation, détail, export, reprise d'un reçu exact et annulation commerciale autorisée.

L'admission de base exige le runtime ERP actif, une capacité actuelle de schéma 4, une entreprise US/USD et au moins un des deux flags actifs. La création et la confirmation exigent en plus le premier flag ; elles ne sont jamais accordées par un simple paramètre navigateur. Un reçu durable déjà écrit peut être retrouvé avant le contrôle d'ouverture des nouvelles opérations, après revalidation des droits. Une réponse ambiguë après envoi d'une écriture garde l'enveloppe idempotente côté client ; elle ne devient pas une preuve de rejet.

Le flag d'historique doit rester actif après une première activation si des commandes sont conservées. Fermer seulement les nouvelles opérations laisse possible une annulation explicite, sous les mêmes droits d'entreprise. Le trigger de protection des sources ne dépend pas de ces flags ; fermer toute lecture ne libère donc pas artificiellement les devis.

## Protection du parcours ERP existant

Le trigger additif refuse la modification d'un devis lié à une commande active avec `PO008`. Le store ERP traduit ce refus en `sales_order_source_locked` (409). Une annulation explicite permet ensuite une nouvelle lecture et une modification, tout en conservant le document commercial archivé.

Le garde de facturation refuse avec `PO011` une facture issue d'une commande non confirmée ou dont la source ne correspond pas exactement. Dans le parcours ERP, ce refus devient `sales_order_invoice_blocked` (409), distinct de `sales_order_state_conflict` utilisé pour une transition de commande invalide. Le refus PostgreSQL annule toute la transaction ERP : facture, compteur, journal, audit et reçu ne sont pas partiellement conservés. Les transports navigateur reconnaissent ces conflits comme des rejets certains, demandent une nouvelle lecture et ne piègent pas l'utilisateur dans une reprise impossible. La permission commerciale d'un membre n'accorde aucune permission financière supplémentaire.

## Recherche et hypothèses

Les événements devis, commande, facture et paiement restent distincts. Le moment fiscal ne découle pas automatiquement du seul nom du document. Les méthodes cash/accrual et les avances ne sont pas interchangeables. La commande est ici un suivi avant exécution ; elle n'annonce pas une comptabilité automatique universelle ni une certification US GAAP. Voir le relevé de recherche sourcé livré avec ce jalon. Aucun prestataire ou tarif n'est créé.

## Validation et retour arrière

Tester transitions, doublons, révisions, sources modifiées, facture préexistante, concurrence, annulation, reprise exacte après réponse perdue, rôles, isolation d'entreprise, révocation et absence d'effet financier. Exécuter la migration avec sa chaîne préalable dans PostgreSQL local embarqué/PGlite sur données fictives. Vérifier notamment la source située hors de la première page, les privilèges SQL/RLS, les gardes de source/facture, les écritures cash/accrual et le parcours de facturation préparée TEST avec preuve fiscale synthétique, sans appel fournisseur réel.

À la préparation de cette livraison, les preuves ciblées des agents sont : 78 tests backend (contrat/store/PostgreSQL local), 93 tests HTTP, 20 tests d'export et 9 tests des gardes ERP à travers les stores, HTTP et transports navigateur. Ces derniers simulent la frontière RPC ; ils ne remplacent pas les tests SQL réellement exécutés. Les exports utilisent de vrais PDF Letter en quatre langues, vérifiés séparément ; aucun reçu fiscal de production n'est créé. Les rapports détaillés et les limites figurent dans `US-SALES-ORDERS-DELIVERY-20261010.md`.

TypeScript, lint, build, régression globale finale et contrôle des vrais composants en quatre langues, clair/sombre et mobile/ordinateur font partie de la recette finale à consolider par le responsable de phase. Les transports d'aperçu restent fictifs et explicitement identifiés. Ces résultats finaux ne sont pas annoncés par ce plan.

La recette hébergée, toute migration de production et toute activation réelle attendent l'approbation explicite prévue par la mission. Aucun paquet Windows/macOS/iOS/Android n'est publié dans ce jalon local.

Retour arrière additif : fermer `INTERNATIONAL_US_SALES_ORDERS_ENABLED`, conserver `INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED` et le code compatible de lecture/annulation, puis revenir sur les changements de présentation si nécessaire. Conserver les tables, compteurs, reçus, audit et gardes SQL ; ne pas supprimer la migration, les commandes ou les protections pour contourner un refus. Un retour à un code qui ignore ces gardes peut rendre les conflits moins compréhensibles : conserver leur traduction ou suspendre les opérations concernées. Aucun retour destructif ni nettoyage de données n'est proposé.
