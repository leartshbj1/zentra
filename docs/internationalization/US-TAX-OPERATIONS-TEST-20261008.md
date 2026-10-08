# Zentra US — opération fiscale durable et émission atomique de TEST

Base locale : `78aa1563589b6c9004d153d3f9aa6482f5a48b6e`. Cette tranche poursuit le même ERP international et préserve le chemin CH. Elle ne déploie aucune migration ou distribution native, ne configure aucun compte Stripe réel et ne remplace pas la version 354 du site commercial.

## Comportement livré

Le calcul reçoit un devis accepté, des coordonnées publiques et déclarations fiscales privées versionnées, une classification explicitement fournie pour chaque ligne et une liaison interne à un compte Stripe **de TEST**. Le mapper résout les montants exacts après remise, la quantité entière, la date fiscale et l'adresse américaine choisie. Il conserve les corps canoniques exacts et leurs empreintes avant tout appel asynchrone. Le montant Stripe est le total net de la ligne ; la quantité ne le multiplie pas une seconde fois.

Les paramètres demandent explicitement `expand: ['line_items.data.tax_breakdown']`. Le résultat est vérifié ligne par ligne : références, quantité, code, montants, adresse, devise, mode, date, couverture et sommes. Une même ligne peut comporter plusieurs juridictions avec des motifs différents ; la taxe d'État et une juridiction sans taxe ne deviennent pas un motif unique inventé. Une preuve privée structurée conserve ces détails. Le document public reste sur son contrat existant de onze champs, avec quatre champs par ligne. Il ne reçoit ni compte Stripe, ni déclarations légales privées, ni réponse brute. L'empreinte fiscale publique préexistante contient cependant les adresses publiques de facture/client ; elle n'est pas présentée comme exempte d'adresses.

Le registre PostgreSQL propose les états `reserved → calculated → committed`. Une opération fixe l'entreprise, l'acteur, le devis, la future facture, les révisions, les paramètres et la clé opaque fournisseur. La fenêtre de reprise reste celle de la réservation initiale : 23 heures, jamais prolongée par un replay. Une erreur indéterminée ne justifie pas de créer une nouvelle clé. Le caller devra vérifier cette borne avant tout nouvel appel externe ; lire le registre ne constitue pas cette admission.

La transaction finale lie la preuve privée au commit ERP existant. Elle enregistre ensemble facture, numéro, reçu, événement/delta et, en comptabilité d'engagement, journal et audit exacts. La base cash ne crée pas artificiellement un journal de créance à l'émission. Des contraintes différées refusent un lien, un reçu ou une opération incomplète. L'ancienne RPC d'émission seule ne suffit plus à insérer une nouvelle facture US dans la pile de migration testée. Les factures déjà émises peuvent encore recevoir un paiement autorisé sans recalcul de leur preuve historique.

Les révisions pays, vendeur, déclarations fiscales et liaison interne sont revalidées sous verrou dans le même ordre que l'ERP existant, sans déplacement de son core. Une modification concurrente empêche la finalisation de l'ancienne réservation. Ces révisions ne détectent pas, seules, une modification distante Stripe : le futur transport doit observer à nouveau compte, Tax Settings et registrations.

## Sécurité et périmètre fiscal

Les nouvelles tables et fonctions sont privées au backend `service_role`, avec RLS active, fonctions invoker et search path vide ; `anon`, `authenticated` et `public` n'obtiennent pas l'accès. L'autorité Auth/D1 réelle reste une responsabilité serveur distincte. Aucun rôle fourni par le navigateur, statut de formulaire ou hash ne crée une permission, une registration, une preuve d'identité du prestataire ou une détermination de nexus.

Le transport considère toutes les réponses RPC comme inconnues. Il exige la portée entreprise/acteur/demande, les empreintes et les corps exacts, puis compare les réponses reserve/record aux valeurs envoyées. Le reçu ERP est copié, figé et limité à cinq champs avant comme après une écriture. Un champ privé supplémentaire ne part pas vers la RPC et ne revient pas au client. Les snapshots JSON bornés refusent getters, `toJSON`, prototypes métier, symboles, cycles, clés NUL et Unicode invalide ; les retours de ligne ordinaires des notes restent conservés. Les bornes de corps sont alignées entre UTF16 et UTF8 dans PostgreSQL, y compris les caractères hors BMP.

Le comptage des caractères hors BMP utilise explicitement la collation PostgreSQL `C`. La plage de regex ne dépend donc pas de la collation de l'appelant ; les tests vérifient aussi sa définition et les bornes BMP/astral. C'est une correction de portabilité, sans prétendre avoir reproduit une erreur sous toutes les locales ICU.

Pour une opération encore en attente, `validateResolvedStripeTaxRequest` et `validateStoredStripeTaxCalculation` doivent être rappelés avec l'horloge serveur fraîche et les heads autorisés. Une preuve périmée ou une liaison changée ne peut plus servir à émettre. La précision privée atteint la microseconde ; la projection publique arrondit l'expiration vers le bas à la milliseconde et refuse la dernière fenêtre partielle. Un reçu déjà committed est historique : il doit être relu sous admission Auth actuelle, sans réémettre ou exiger que les taux historiques soient encore valides.

La première prise en charge reste conservatrice : services, USD, prix exclusifs, quantités entières, maximum 100 lignes, adresse US explicite et classifications confirmées par une future autorité amont. Biens/livraisons, frais hors ligne, prix inclusifs, exemptions client, quantités rationnelles, lignes nettes nulles, `not_collecting`, `not_supported` et autres résultats non représentables sont refusés. Aucun taux local unique ou table exhaustive américaine n'est inventé. L'absence de taxe doit avoir un motif représentable ; elle ne suffit jamais à établir une exemption juridique.

Une calculation Stripe n'est pas une Tax Transaction, une déclaration d'impôt ou son paiement. L'outbox de transactions fiscales, reversals/avoirs, paiements partiels, responsabilités du vendeur, nexus, classifications et périmètre légal restent des travaux distincts à valider. Aucune certification US GAAP, SOC 2 ou conformité fiscale automatique n'est revendiquée.

## Migration proposée et retour arrière

Nouvelle migration additive : `supabase/migrations/20261008060826_international_us_tax_operations.sql`. Elle dépend des migrations pays, ERP, vendeur public et déclarations fiscales privées existantes. Elle ajoute les liaisons de prestataire et leur historique, les opérations fiscales et les liens de facture, les RPC et les gardes transactionnelles. Les 132 fichiers SQL suivis à la base restent inchangés.

La migration est exécutée uniquement dans PostgreSQL local pour cette preuve. Aucun projet Supabase hébergé, compte client, région, abonnement CHF, QR-facture CH ou clé de production n'est modifié. Avant production : revue de la migration, staging avec données fictives, deux connexions PostgreSQL réelles, reprise après redémarrage et approbation explicite du titulaire.

Retour arrière proposé : conserver les flags US fermés et retirer les branchements runtime futurs ; préserver tables, preuves, reçus et audits. Ne pas supprimer les liens ou réautoriser l'ancienne émission sans preuve sur des données déjà engagées. Aucun downgrade destructif n'est proposé.

## Vérification et limites

Les résultats exacts de la régression, des contrôles TypeScript/lint/build et les empreintes des sources sont consignés dans [la preuve consolidée](../evidence/us-tax-operations-test-20261008.json). Les tests ciblent les consommateurs CH déjà sélectionnés, l'ERP international, les trois parcours navigateur locaux existants, les garde-fous du prestataire et la nouvelle pile PostgreSQL. Les essais fake RPC testent le transport ; ils ne remplacent pas PostgREST hébergé.

Sur les sources finales : **2 440 tests réussis, aucun échec ni test ignoré, 63 fichiers**. Ce total comprend 56 tests du mapper, 74 du calcul/preuve, 19 des snapshots JSON, 83 des reçus, 141 du transport des opérations et 89 de la nouvelle pile PostgreSQL. Les trois parcours navigateur locaux antérieurs passent aussi. TypeScript global, Oxlint type-aware sur les 13 fichiers TypeScript créés/modifiés, build Vinext et `git diff --check` passent. Le build garde son avertissement connu de classification statique de routes ; les QA navigateur gardent l'avertissement de chunks au-delà de 500 kB. Ils ne prouvent ni sessions hébergées ni performances d'appareil.

Le premier passage complet s'est arrêté sur l'allowlist explicite des migrations du test de création : 62 fichiers étaient verts et les six cas de cette suite n'avaient pas été exécutés. L'ajout de la migration à cette liste et de ses quatre tables aux vérifications d'absence de données a permis leur exécution réelle. Le passage final reprend les 63 fichiers sur les sources gelées après cette mise à jour et la correction de collation, sans masquer les essais interrompus précédents.

Le scénario vertical nouveau utilise le vrai moteur ERP, les adaptateurs privés, les normalisateurs et les RPC dans PGlite. Les données, l'autorité et le calcul fournisseur sont explicitement fictifs. PGlite reste une seule connexion sérialisée en RAM : aucune durabilité après crash, concurrence hébergée ou capacité de production n'est prouvée. Les trois tests navigateur régressent les formulaires ERP/vendeur/fiscal existants ; aucun nouveau parcours HTTP ou interface d'émission Stripe n'est encore installé.

Un test a découvert un `projectId` optionnel présent avec `undefined` pour les devis sans projet. Le moteur omet maintenant ce champ quand il est absent, comme son ancien JSON sérialisé ; le snapshot privé n'est pas assoupli. Les cas de montant, révision, reprise, permissions, expiration, absence de liaison, preuve altérée, données publiques/privées, facture sans projet, journal et Unicode sont vérifiés dans les suites de ce lot.

Le fournisseur dans `runtime-bindings.ts` retourne toujours `null` et les flags sont fermés par défaut. La sandbox Stripe contrôlée reste à établir. Aucun appel réel à `tax.calculations.create`, Tax Settings, registration, paiement ou tarif n'a été effectué par cette tranche. Les limitations d'accès externes déjà constatées sont détaillées dans [la tranche précédente](US-TAX-PROFILE-BROWSER-20261008.md).

Le SDK Stripe ajoute un champ technique non enumerable `lastResponse` à ses réponses. Le futur gateway doit séparer explicitement ce metadata du JSON métier avant le normalisateur strict, sans relâcher les règles du helper ni persister les headers/request IDs dans la preuve publique. Ce prérequis de branchement est distinct des réponses JSON fictives testées ici.

## Fichiers et suite

Créés :

- `lib/international/private-json.ts` et `.test.ts`.
- `lib/international/stripe-tax-resolved-request.ts` et `.test.ts`.
- `lib/international/stripe-tax-calculation.ts` et `.test.ts`.
- `lib/international/us-tax-operation-store.ts` et `.test.ts`.
- `lib/international/runtime-store.test.ts`.
- `lib/international/us-tax-operations.postgres.test.ts`.
- La migration additive et ce rapport avec sa preuve consolidée.

Modifiés : `lib/international/runtime-store.ts` pour les reçus exacts, `lib/international/invoicing.ts` pour l'omission du projet absent et `lib/international/workspace-creation.integration.test.ts` pour charger la chaîne additive complète et vérifier que ses quatre nouvelles tables privées restent vides à la création.

Terminé localement : paramètres résolus, normalisation privée/publique, transport strict, réservation durable, révisions, émission atomique de TEST et reprise historique. Expérimental/non installé : orchestration serveur d'émission, gateway réel de TEST, workflow financier de production et toute l'édition US.

La prochaine tranche doit réunir ces contrats derrière une admission financière réelle, revalider les droits avant/après chaque attente, vérifier les observations fiscales et la clé de compte/environnement, puis tester un calcul réel dans une sandbox contrôlée. Elle doit lire les faits privés via un port financier interne avec le rôle réel ; fabriquer un propriétaire pour contourner le GET privé serait interdit. Elle doit aussi comparer l'origine déclarée au `head_office.address` des Tax Settings du compte de TEST : des empreintes opaques ne prouvent pas cette correspondance. L'installation du fournisseur et toute migration de production nécessitent ensuite leurs preuves et l'approbation explicite, sans modifier les abonnements suisses existants.

## Sources primaires utilisées

- [Calculations API](https://docs.stripe.com/api/tax/calculations/create) — paramètres, date, montants et expansion.
- [Standalone Tax API](https://docs.stripe.com/tax/standalone-tax-api) — breakdowns de juridictions et limites du modèle.
- [Idempotent requests](https://docs.stripe.com/api/idempotent_requests) — conservation puis purge possible des clés après au moins 24 heures.
- [PostgreSQL — POSIX bracket expressions](https://www.postgresql.org/docs/current/functions-matching.html#POSIX-BRACKET-EXPRESSIONS) — portée des plages et collations dans les regex.
- SDK Stripe `22.6.0` installé, API `2026-08-26.dahlia` et schémas Tax locaux correspondants ; consultation de documentation, pas preuve d'appel prestataire.
