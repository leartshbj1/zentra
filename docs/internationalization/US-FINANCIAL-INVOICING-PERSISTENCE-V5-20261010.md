# Zentra US — plan d'émission fiscale sur le livre V5

Actualisation du 10 octobre — nouvelle émission durable livrée localement sous capacité privée TEST : voir [US-FINANCIAL-TEST-INVOICING-V5-20261010.md](US-FINANCIAL-TEST-INVOICING-V5-20261010.md), implémentation `41df1a7`, preuve `docs/evidence/us-financial-invoicing-v5-20261010.json`. La régression finale passe 5 144/5 144 tests dans 152 fichiers ; types, lint, marque et build passent. Le texte ci-dessous conserve le relevé ou plan historique. Aucun hébergement, fournisseur réel, UI ou natif modifié par ce lot.

10 octobre 2026. **Plan avant implémentation ; aucun résultat de recette de ce lot annoncé.** La comptabilité précédente est livrée localement dans `US-FINANCIAL-TEST-ACCOUNTING-V5-20261010.md`, implémentation `05cd853`, preuves `8c6dd17`. Le prochain résultat concret est une nouvelle facture durable, encaissable et créditable sur le même livre, puis un consommateur pilote avec rapports. Aucun déploiement, migration hébergée, abonnement ou donnée CH ne change.

## 1. Modifications proposées

Ajouter la capacité privée `postgres-test-invoicing-v5` : les dix commandes ERP accounting, `issue_invoice`, avoirs et encaissements. Même baseline immuable, événements, révisions, CAS, curseur et reçus financiers ; aucun deuxième grand livre. `resolveIssuance` est déjà un hook privé du runtime, et `transitionUsFinancialErpV5` reconstruit la vraie facture et `postCustomerInvoice` sur le vrai ledger. Réutiliser ce moteur, sans créer un calcul comptable concurrent.

Le périmètre fiscal existant reste fermé : US/USD/accrual/TEST, configuration fiscale déjà préparée, devis accepté courant, période ouverte, destination US explicite, services taxables hors taxe, quantités entières positives et limites du prestataire déjà vérifiées par les fonctions pures. Ni taux d'État inventés, ni biens/exemptions/lignes gratuites activés implicitement. Un cas non pris en charge est refusé avant le gateway.

### Préparation, contexte et opération durables

Les anciens stores fiscaux sont liés aux heads/records ERP4 gelés et à un reçu intérieur `issue_invoice` ; ils ne peuvent pas recevoir un faux `supportedSchemaVersion: 5`. Conserver ces tables comme historique. Ajouter des registres privés V5 pour contexte admis, préparation et opération, sans soldes ni ledger courant. Le rôle serveur ne peut pas fabriquer son propre contexte marchand : provenance immuable DB-owner-only pour ce premier lot local TEST. Pas de clé API dans ces tables.

Le contexte V5 conserve configuration identique à la baseline, snapshots/révisions vendeur/fiscalité historiques complets, identité de credential TEST, empreinte, observation, auteur/date/hash et origine explicite. Une fixture reste `test_fixture`, avec opt-in local TEST ; ne jamais la rebaptiser `provider_observation`. L'ancien validateur de préparation exige cette dernière origine : adapter le contrôle V5 de façon limitée et typée, sans falsifier les entrées ni affaiblir les ports anciens. Une observation historique expirée ne devient pas fraîche par copie. Profil absent ou configuration baseline `unconfigured` : refus ; nouvel événement de configuration hors périmètre.

La préparation lie la requête financière externe exacte, son hash, la requête ERP intérieure et son autre hash, le fingerprint/révision du livre, le devis accepté exact, vendeur et contexte fiscal, classifications humaines, destination et instant fiscal. L'opération conserve identifiant, paramètres/corps canoniques et leurs hashes, clé fournisseur, observation/preuve, assessment, horloges et fenêtre de reprise d'origine. États `reserved` → `calculated` → `committed`, avec lien atomique final vers l'événement, facture et reçu financier externe. Ne pas traiter une réservation comme un reçu terminé.

### Ordre et reprises

1. Lire d'abord le reçu historique sous autorité vivante ; une reprise exacte committed ne consulte ni contexte frais, ni catalogue, ni gateway.
2. Préflight SQL sur livre/révision/devis/période/configuration/PO011 avant toute nouvelle observation ou consultation de catalogue.
3. Capturer et valider les choix humains et le contexte privé ; réserver durablement la requête sous CAS et fingerprint exact avant calcul.
4. Calcul via gateway injecté, exclusivement fictif dans ce lot ; enregistrer et valider les preuves conservées, sans nouvelle clé ou fenêtre en cas de reprise.
5. À l'append financier, sous verrou commun, relire autorité, source, période, contexte, preuve et PO011 ; reconstruire indépendamment facture, numéro, vrai journal et effets. Événement/reçu/curseur et liaison d'opération `committed` doivent être cohérents dans la même transaction.

Une révision différente impose refus/revue ; aucun retarget silencieux d'un ancien calcul. Réserver, calculer et committer sont des temps distincts : le CAS final ne garantit pas qu'aucun calcul ne devienne inutile. Aucun verrou SQL ne reste tenu pendant un appel gateway. Aucun transfert, transaction fiscale, reversal ou email n'est exécuté. Le futur effet fournisseur non idempotent exigera un outbox durable après CAS, pas un effet financier préalable.

## 2. Fichiers à créer

- `lib/international/us-financial-test-invoicing.ts` : entrée nommée du profil financier.
- `lib/international/us-financial-invoice-test.ts` : contrats, validation et composition du resolver fiscal privé.
- `lib/international/us-financial-invoice-test-store.ts` : adapter RPC du registre fiscal privé, capture/autorité vivante et validation des réponses.
- `lib/international/us-financial-invoice-test.test.ts` : recette moteur réel/gateway et RPC explicitement fictifs.
- `lib/international/us-financial-test-invoicing.postgres.test.ts` : verticale réelle PostgreSQL locale, historique mixte et reprise.
- Nouvelle migration additive créée via la CLI Supabase, nom/version à enregistrer après création ; anciennes migrations intactes.
- Livraison et preuve finale du lot, après exécution réelle.

Les signatures peuvent être précisées en commun avant rédaction SQL/adapter. Chaque champ externe/intérieur et chaque état doivent avoir un contrat typé fermé partagé ; les faits fiscaux restent hors requête publique.

## 3. Fichiers à modifier et réutiliser

- `us-financial-kernel-runtime.ts` : nouvelle capacité et allowlist exacte accounting + `issue_invoice`, sans élargir un port ancien ; hook privé existant conservé.
- `us-financial-test-store.ts` : profil nommé constant, validation des queues et mapping des refus.
- Réutiliser `stripe-tax-resolved-request.ts`, `stripe-tax-calculation.ts`, `us-tax-invoice-time.ts`, les validations pures vendeur/fiscalité/credential et le moteur documentaire/comptable existant. Ne pas rouvrir leurs RPC ERP4.
- Projection SQL : inclure factures nouvelles et compteur ; règlements doivent chercher la facture dans le registre courant, plus seulement `baseline.invoices`. Headers dérivés et reçus restent corroborés.
- Statut, plan d'ensemble et livraison accounting seront actualisés sans modifier leurs résultats historiques.

Ne pas changer public ERP1–4, native, UI, routes, prix, facturation SaaS, CH ou politique fiscale pour faire passer ce lot.

## 4. Migration, autorité et retour arrière

Conserver l'ordre installé : workspace → country config → tête ERP4 gelée → grant TEST → cursor V5 → profils vendeur/fiscalité/binding en ordre fixe → contexte V5 → préparation/opération. Grants versionnés vivants, READ COMMITTED, rôle owner/admin/accountant, policy et horloges TEST à chaque temps ; ce protocole local ne devient pas une transaction Auth/D1/Stripe/PostgreSQL.

Réserver les clés contre reçus financiers, toutes opérations V5, anciennes `tax_operations` et `tax_invoice_preparations`, ainsi que collisions d'identifiants d'opération/facture/clé fournisseur. Toutes les nouvelles mutations, y compris INSERT direct d'événement, doivent respecter la réservation. Garder distinctes clé brute d'opération et clés générées de journaux. Une reprise historique exacte reste résolue avant garde live de source/merchant.

PO011 est actuellement un trigger sur anciens records ; implémenter un helper V5 sous le verrou workspace, avant gateway puis à l'append : absence d'ordre actif admise ; ordre actif confirmé, même révision/lignes/client/projet/notes, émission après confirmation. Ne pas le réappliquer rétroactivement au replay. PO008 et gel des sidecars restent conservés.

Les validateurs JSON/canonical/math/proof SQL purs sont réutilisables. Le composite transitoire de l'ancienne table d'opérations peut servir au validateur de preuve s'il ne déclenche aucun INSERT/lecture legacy et si chaque champ provient de l'opération V5 validée ; ses fonctions current/commit couplées ERP4 ne le peuvent pas. ACL privées, RLS, invoker et search_path vide ; registre contexte réservé DB-owner, aucune permission anon/authenticated.

Avant et après changement du replay, valider sous les mêmes verrous livres/plans/curseurs/reçus existants ; aucune réécriture. Tous les anciens profils financiers refusent une nouvelle queue invoice avant read/receipt/retry. Historiques ERP4/tax restent gelés. Retour arrière prévu : révoquer/fermer grants, conserver lecteur compatible et toute histoire, réparer additivement ; aucun retrait d'événement ou fallback baseline. Restrictions administratives héritées TRUNCATE, même CH/non promues, conservées et à examiner avant hébergement.

## 5. Tests prévus — non exécutés pour ce lot

Conserver les **150 fichiers/5 070 tests** du lot précédent et ajouter les deux fichiers de recette ; ne pas annoncer leurs résultats avant exécution. Types globaux non incrémentaux, lint typé des fichiers concernés, marque et build de production. PostgreSQL local réel avec toute la chaîne de migrations puis nouvelle migration, données fictives, NodeFS close/reopen propre, ACL/RLS et atomicité des refus. Pas de preuve de crash ou concurrence multiconnexion.

Verticale obligatoire : avoir existant → journal/clôture/ouverture → nouveau client/devis accepté → préparation → facture nouvelle → encaissement → avoir de cette nouvelle facture, sur le même livre et avec AR, revenu, taxe et cash exacts. L'avoir taxé exige toujours son plan privé admissible ; un calculationId n'est jamais inventé comme transaction fiscale originale.

Refus à couvrir : période fermée, PO011 brouillon/mismatch, source changée, ancienne clé fiscale pendante, doublons inter-opérations, preuve/hash/compte/tenant falsifiés, confusion hash intérieur/extérieur, fixture rebaptisée réelle, révision ou autorité modifiée entre awaits. Réponses perdues à réservation/preuve/append, reprises après événements ultérieurs et expiration du contexte sans nouveau calcul/numéro. INSERT direct, refus des anciens ports, préservation CH et migration sur historique mixte existant.

## 6. Risques et limites

Une fixture validée prouve le protocole local, pas le comportement d'un compte Stripe réel, sa registration/nexus, la conformité de ses classifications ou l'exactitude légale d'une taxe. Le gateway de ce lot n'instancie aucun SDK/secret et n'appelle aucun fournisseur. Les versions et preuves déjà enregistrées restent intactes ; pas de mise à niveau SDK/API implicite dans une migration d'historique.

Une calculation `taxcalc_…` n'est pas une Tax Transaction, une déclaration ou un reversal. Les transactions/reversals réels et compensations nécessiteront un outbox et une validation séparés. Les reprises pending expirées peuvent exiger une décision humaine, pas un allongement automatique. Configurations non préparées et sidecars historiques gelés limitent le périmètre de ce premier lot. Replay borné, PGlite sérialisé, autorité distribuée non atomique, absence de SLA/charge/staging hébergé restent explicites. Aucune certification US GAAP ou garantie de conformité n'est annoncée.

## 7. Critère de fin

Une nouvelle facture client est durable, numérotée une fois, encaissable et créditable sur le vrai livre V5, avec preuve TEST et reçu corroborés indépendamment en SQL, reprise sans doublon et sources anciennes préservées. Les suites antérieures passent. La livraison distingue code terminé localement et intégration encore privée/expérimentale.

## 8. Suite immédiate : consommateur pilote

Après cette verticale, ne pas ajouter seulement une préparation de plus. Livrer un contrat `financial-pilot` DTO1 séparé, whitelist sans baseline/policy/promotion/events/commits/proofs/empreintes/grant, pages bornées à la révision et head léger toutes trois secondes. Factures affichent **total = reçu + crédité + restant** ; ne pas utiliser les anciens workbench/exports qui dérivent reçu = total − restant.

Réutiliser `accounting/reports.ts` sur le vrai ledger pour balance/résultat/bilan/trésorerie/grand livre, plus AR courant et export distinct. Puis HTTP/auth réels du pilote, session navigateur et UI dédiée factures/avoirs, journaux/périodes, rapports avec brouillons conservés durant actualisation silencieuse. La page workspace choisit explicitement le consommateur, sans faux ErpState4 ni header ERP5 ou activation native. Recette future deux navigateurs → HTTP réel → PostgreSQL local, en indiquant toute Auth fictive éventuelle. L'objectif ERP US complet reste actif.
