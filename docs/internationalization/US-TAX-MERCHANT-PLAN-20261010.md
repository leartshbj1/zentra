# Marchand fiscal US — admission TEST et readiness

10 octobre 2026. Base isolée `beca906622dc76778f40cf1257531f05970810da`. Ce jalon poursuit la phase E de l'audit ; il ne livre pas encore un ERP US complet et ne modifie ni le site CH publié ni la copie native.

## Constat vérifié avant développement

- Le gateway `stripe-tax-test-gateway.ts` vérifie déjà le compte courant, le mode TEST, les réglages actifs, l'adresse fiscale et les registrations actives paginées. Une observation ne constitue ni une autorisation ni une preuve de nexus légal.
- Le lecteur `us-tax-financial-context.ts` exige un binding existant : il ne convient pas à la première configuration.
- Le RPC historique de binding compare sa seule révision. Il ne protège pas les faits pays/vendeur/fiscaux capturés avant les appels externes.
- Le runtime garde `taxProvider: async () => null`. Le hook privé `issueInvoiceTest` demeure la seule voie future d'émission avec réservation et preuve durable ; ce jalon ne l'installe pas.

## Contrat et étapes

1. Ajouter un résolveur serveur dédié par entreprise. Configuration privée versionnée, compte `acct_`, référence et révision de credential ; seules les clés restreintes TEST `rk_test_` sont acceptées. Aucun secret, choix de compte ou hash envoyé par le navigateur ; aucun fallback vers le client Stripe des abonnements. Un client SDK séparé par résolution, API `2026-08-26.dahlia`, zéro retry réseau automatique, timeout borné. La configuration entière est validée, les réutilisations entre entreprises sont refusées. La résolution seule n'accorde aucun droit.
2. Capturer sous admission propriétaire fraîche les snapshots et révisions pays/vendeur/faits, avec révision du binding (zéro permis). Observer le fournisseur hors transaction. Revalider l'identité, le rôle, les droits Gestion, la gate et la configuration marchande après les phases asynchrones, y compris leurs erreurs.
3. Ajouter un RPC privé `SECURITY INVOKER` : même ordre de verrous que les opérations fiscales ; comparaison des quatre révisions et des trois snapshots ; observation TEST uniquement, origine/fuseau identiques, âge maximal 120 secondes et expiration au plus 120 secondes après observation. Construire le binding côté serveur/SQL, jamais accepter un fixture. L'activation explicite configure atomiquement le statut fiscal pays TEST et son historique uniquement s'il était non configuré. L'observation seule ne change rien. Le cache ERP reste soumis à son mécanisme explicite `refresh_configuration`.
4. Ajouter un reçu d'admission immuable avec identité marchande privée, payload capturé et résultat. Reprise exacte sans nouvelle mutation ; même identifiant avec contenu différent refusé. Une reprise historique ne réécrit jamais les têtes actuelles. Ne conserver aucune clé dans PostgreSQL, réponses HTTP ou logs. La référence/révision est une provenance de configuration serveur, pas une preuve juridique ni une atomicité entre environnements et PostgreSQL.
5. Installer un endpoint propriétaire borné et une projection publique minimale, derrière `INTERNATIONAL_US_TAX_TEST_MERCHANT_ENABLED` en plus des gates Core/ERP. POST accepte uniquement un UUID `requestId`. Reprise du reçu propre à cet acteur avant toute nouvelle observation. GET ne fait aucun appel fournisseur et ne renvoie ni compte ni faits privés. Raccorder la readiness financière à une résolution dédiée et une vérification réelle du gateway ; réponses `ready_test` seulement, sans grant d'émission.
6. Tester les ports, erreurs sans secrets, changements d'autorité/configuration, tenant, fixtures/live, CAS et idempotence ; exécuter une vraie migration PostgreSQL locale (PGlite), les contrôles ciblés CH, TypeScript, syntaxe et build. Livrer les huit rubriques et les preuves réelles.

## Sources officielles consultées

Documentation Stripe consultée le 10 octobre 2026 via le connecteur documentation : [Testing Stripe Tax](https://docs.stripe.com/tax/testing), [Registrations API](https://docs.stripe.com/tax/registrations-api?tax-integration=direct), [Tax settings](https://docs.stripe.com/tax/settings-api), [Tax for software platforms](https://docs.stripe.com/tax/tax-for-platforms). Une registration TEST ne modifie pas le live. Le périmètre des permissions restreintes doit être vérifié dans le sandbox retenu ; aucune clé réelle n'est créée ni testée dans ce jalon.

## Fichiers concernés et risques

Nouveaux : résolveur marchand, service/handlers d'admission, store privé, migration additive créée via CLI, tests locaux et rapport. Modifiés : bindings runtime et exemple d'environnement privé, documentation de statut. Réutilisés : gateway, lecteur financier, readiness, admission Auth/D1, histories et verrous PG existants.

Aucune migration hébergée, aucun changement Stripe ni publication n'est autorisé par ce plan. Les contrôles Auth/D1, configuration serveur et fournisseur ne sont pas une transaction distribuée ; les revalidations et CAS limitent les courses sans promettre l'impossible. Les expirations/registrations sont revérifiées par le gateway à la consommation ; un TTL court ne remplace pas cette vérification. La validation sandbox réelle et la recette professionnelle restent nécessaires avant activation commerciale. Le reverse SQL éventuel est manuel, après vérification qu'aucun reçu/usage dépendant ne serait perdu ; désactiver d'abord la gate.
