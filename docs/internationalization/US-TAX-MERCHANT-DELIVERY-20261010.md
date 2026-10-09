# Zentra US — marchand fiscal TEST

10 octobre 2026, branche isolée `codex/international-runtime`, base `beca906622dc76778f40cf1257531f05970810da`. Le plan a été écrit avant le développement. Ce jalon livre un chemin serveur local d'admission et de readiness ; il ne termine pas l'ERP US et n'active aucune fonction de production.

## 1. Modifications

Un propriétaire peut explicitement demander l'observation d'un marchand fiscal TEST dédié à son entreprise. Le serveur résout la configuration privée, puis vérifie le compte, le mode TEST, les réglages actifs, l'origine fiscale et les registrations avec le gateway Stripe existant. Le navigateur ne choisit ni compte ni secret et ne fournit aucune preuve fiscale. Aucun appel Stripe d'écriture ni calcul réel n'a été effectué dans cette livraison.

L'admission compare atomiquement les révisions et contenus pays, vendeur et faits fiscaux, ainsi que la révision de binding. Si le statut fiscal pays était non configuré, elle écrit sa nouvelle version et son historique dans la même transaction que le binding et le reçu d'admission. Une observation seule ne configure rien. La reprise du même UUID/acteur utilise son reçu immuable sans nouvel appel fournisseur ; une reprise historique ne réécrit pas les têtes.

La readiness financière utilise le véritable rôle propriétaire, administrateur ou comptable. Elle exige une provenance d'admission correspondant aux données et à la configuration marchande courantes, puis revérifie le fournisseur. Une seconde lecture des faits et révisions après l'appel externe empêche de publier une disponibilité basée sur une configuration changée pendant cet appel. La réponse reste informative et TEST ; elle n'autorise jamais l'émission.

Les erreurs et diagnostics sont bornés et ne contiennent ni compte marchand, ni adresse fiscale, ni clé, ni réponse Stripe brute. Les appels sont encadrés par une admission Auth/D1 fraîche, les gates, la configuration privée versionnée, une horloge monotone et un budget d'observation de trente secondes. Un appel externe déjà lancé n'est pas annulé au délai global ; une réponse tardive ne peut plus déclencher une nouvelle admission. Un commit déjà réussi avant une perte d'accès reste durable, mais sa réponse privée est retenue.

## 2. Fichiers créés

- `lib/international/us-tax-merchant-resolver.ts` et son test : résolution privée complète, détection des doublons, clés restreintes TEST, séparation des abonnements et empreinte de rotation.
- `lib/international/us-tax-merchant-store.ts` et son test : ports privés et validation stricte des snapshots/reçus.
- `lib/international/us-tax-merchant-server.ts` et son test : GET informatif, POST propriétaire, reprise et contrôles autour des phases asynchrones.
- `lib/international/us-tax-merchant-readiness.ts` et son test : raccordement des rôles financiers réels, provenance courante et seconde lecture après fournisseur.
- `lib/international/us-tax-merchant.postgres.test.ts` : admission et invariants sur un vrai PostgreSQL local PGlite.
- `app/api/international/workspaces/[organizationId]/tax-merchant/route.ts` : forwarding GET/POST vers les handlers protégés.
- Migration additive, plan, présente livraison et relevé machine `docs/evidence/us-tax-merchant-20261010.json`.

## 3. Fichiers modifiés

- `lib/international/runtime-bindings.ts` : gate distincte, résolveur privé, admission et evaluator de readiness. Le prestataire générique reste null et `issueInvoiceTest` n'est pas installé.
- `lib/international/runtime-bindings.test.ts` : fermeture par défaut avant Auth/stockage et absence de hook d'émission.
- `lib/international/us-tax-operations.postgres.test.ts` et `us-tax-invoice.postgres.test.ts` : recette du moteur fiscal existant après application de la nouvelle migration, dont preuves historiques et reprise exacte.
- `.env.supabase.example` : exemples vides et gate false, aucune vraie clé.
- `docs/internationalization/STATUS-20261009.md` : état et prochaine étape.

La liste exacte et les empreintes sont dans le relevé machine. Aucun fichier de l'édition native ou de la copie du site CH publié n'a changé.

## 4. Migration et retour arrière

Migration `20261009222319_international_us_tax_test_merchant.sql`, générée par `supabase migration new` avec la CLI locale 2.120.0. Le préfixe est en UTC (9 octobre), la livraison est datée en Europe/Zurich (10 octobre). Table privée de reçus append-only, contraintes de provenance, RPC `SECURITY INVOKER` avec search_path vide, RLS et absence de privilèges anon/authenticated. Le service ne reçoit que SELECT/INSERT sur les reçus, jamais UPDATE/DELETE ; les triggers refusent aussi modification et TRUNCATE.

Aucune ancienne migration réécrite ni donnée supprimée. La migration a été appliquée uniquement aux bases RAM locales de test. Aucun push/migration hébergée, mouvement de région ou publication n'a été exécuté. Avant staging/production, obtenir l'approbation explicite demandée par l'utilisateur et vérifier la chaîne réellement déployée.

Retour arrière : désactiver d'abord `INTERNATIONAL_US_TAX_TEST_MERCHANT_ENABLED`, retirer le raccordement runtime si nécessaire et conserver l'historique. Aucun script automatique ne supprime les reçus ni ne remet silencieusement le statut fiscal à son ancienne valeur. Un retrait de schéma exige une analyse des dépendances et une approbation.

## 5. Tests exécutés et résultats

Résultats définitifs, sans additionner les relances : **679 tests ciblés web/ports, 154 tests PostgreSQL, 833 au total**, tous réussis, zéro échec et zéro test ignoré dans ces deux exécutions. Rapports locaux `.qa/us-tax-merchant/targeted-final.json` et `postgres-final.json`.

Les 154 tests PostgreSQL comprennent douze tests d'admission et 142 tests du moteur fiscal/proofs/issuer existant exécutés après la nouvelle migration. Les 679 tests incluent les nouveaux ports/handlers/races, gateway, readiness, contexte financier et issuer, plus 87 régressions ciblées Auth, Stripe et fournisseur Automation partagés. Les SDK, Auth/D1 et observations restent injectés ; ces essais ne remplacent pas une observation sandbox réelle.

TypeScript global, Oxlint de syntaxe sur les quatorze fichiers TypeScript concernés, contrôle de marque et compilation Vinext de production : succès. Le build conserve l'avertissement de classification statique de certaines routes ; sa réussite n'est pas un test HTTP de ces routes. Les premières erreurs de typage (snapshot unknown et littéraux BigInt sous ES2017) ont été corrigées avant la validation finale. Une vérification complémentaire a fermé le contournement de séparation SaaS par espaces dans une variable de clé, puis les contrôles ciblés et le build ont été relancés.

Pas de test natif Windows/macOS/iOS/Android, de recette visuelle supplémentaire (aucun composant visuel modifié), de charge 150 entreprises, de test de facturation réelle ou de suite globale entièrement verte annoncée. Les limites Windows/workerd documentées dans le jalon Team antérieur ne sont pas requalifiées ici.

## 6. Risques et limites

- L'observation technique n'atteste ni nexus, ni enregistrement juridique, ni classification correcte des produits. La configuration et la validation professionnelle du marchand restent nécessaires.
- Seules des clés restreintes TEST dédiées sont acceptées. Les permissions exactes de la clé et le sandbox isolé doivent être vérifiés lors de la recette réelle ; aucun accès réel n'a été créé ou utilisé ici. Le préfixe TEST ne constitue pas la preuve : le gateway vérifie aussi compte et mode.
- Les maps privées sont bornées à 128 marchands et 64 Kio chacune. Il s'agit d'une configuration de pilote, pas d'un coffre commercial ou d'une capacité de production démontrée. Toute rotation exige de versionner la référence ; l'empreinte détecte aussi une rotation de clé sans changement de référence.
- Le TTL d'admission est au plus 120 secondes après observation. Une expiration ne remet pas automatiquement le pays en non configuré ; la readiness et le gateway refusent une preuve périmée. L'opérateur doit demander une nouvelle observation explicite. La commercialisation demandera une gestion/renouvellement des marchands adaptée.
- Auth/D1, configuration déployée, Stripe et PostgreSQL ne forment pas une transaction distribuée. Les contrôles autour des phases et les CAS réduisent les courses ; une disponibilité informative ne garantit jamais un futur commit. Le futur issuer devra conserver ses propres réservations et contrôles atomiques.
- L'admission modifie la configuration pays, pas le cache ERP. Celui-ci doit passer par `refresh_configuration` avant une readiness sur le nouvel état ; aucune réémission financière automatique.

## 7. Terminé dans ce jalon

Résolution privée dédiée, refus live/fixtures/SaaS/interentreprises, admission propriétaire atomique, historique immuable, reprise exacte, provenance versionnée et disponibilité TEST avec contrôle après observation. Les gates restent fermées par défaut ; l'édition CH publiée et la copie native sont préservées.

## 8. Encore expérimental et prochaines étapes

L'émission fiscale runtime US reste fermée. Prochaine verticale : enregistrer les classifications de services explicitement confirmées et l'instant fiscal de facture, puis raccorder le hook `issueInvoiceTest` avec réservation/preuve durable et reprise. Le périmètre actuel de ce gateway ne couvre pas tout le commerce américain. Ensuite : sandbox autorisé, pilote hébergé approuvé et validation professionnelle, tarifs/Checkout USD distincts, Support/originaux US et cycle commercial complet. Aucune conformité US GAAP, SOC 2 ou fiscale exhaustive n'est annoncée.

Sources techniques officielles consultées : [Stripe Tax TEST](https://docs.stripe.com/tax/testing), [registrations](https://docs.stripe.com/tax/registrations-api?tax-integration=direct), [taxes pour plateformes](https://docs.stripe.com/tax/tax-for-platforms), [fonctions PostgreSQL Supabase](https://supabase.com/docs/guides/database/functions), [mise à jour PostgreSQL 15.19/17.11](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes). Le changelog Supabase a été relu ; ce jalon n'ajoute ni ltree, chiffrement PGP ancien, index float btree_gist ni opérateur personnalisé concernés par cette dernière note.
