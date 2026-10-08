# Zentra US — orchestration privée d'émission et reprises de TEST

Base : `703ed1d00b4b2ebee23a568050dd736a495cc38e`. Cette étape poursuit le même ERP international, sans modifier les données clients, les abonnements CHF, les distributions natives ou le site commercial publié en version 354. Aucun compte, registration, paiement ou calcul Stripe réel n'est créé. Les migrations proposées précédemment restent inchangées et non déployées par ce lot.

## Comportement livré

`executeUsTaxInvoiceTest` réunit le moteur ERP existant, un lecteur financier privé, le registre durable des opérations fiscales et un gateway de TEST explicitement injecté. Il reçoit la configuration réellement autorisée et le rôle financier réel — propriétaire, administrateur ou comptable — sans fabriquer de propriétaire pour lire un formulaire privé. Seule la commande `issue_invoice` est admise. La configuration US doit déjà être prête ; ce service ne transforme pas une déclaration de formulaire en activation fiscale.

Le reçu ERP historique est consulté avant les déclarations, paramètres ou classifications actuels. Une course vers une opération déjà committed se termine aussi par une relecture autorisée du reçu, sans réémission et sans exiger que son ancien calcul soit encore valide. Une tentative en attente conserve les mêmes UUID, adresse choisie, date fiscale, paramètres, empreintes et clé fournisseur. Un état reserved ne relance le calcul que dans sa fenêtre initiale de 23 heures. Un état calculated réutilise sa preuve fraîche, sans calcul supplémentaire. Aucun retry automatique, nouvelle clé après expiration ou prolongation de preuve n'est ajouté.

Les devis non acceptés et les échéances antérieures à la date de facture sont refusés avant toute réservation ou appel fiscal. Les révisions pays, vendeur, déclarations, liaison, devis et ERP sont comparées avant et après les attentes critiques. La preuve est revalidée avec l'horloge serveur jusqu'au commit atomique déjà défini : facture, numéro, lien privé, reçu, delta et journal/audit en comptabilité d'engagement. L'admission Auth/D1, le rôle, l'entreprise et les droits de module sont relus autour des phases asynchrones ; la revalidation HTTP porte aussi le mode de session et les flags.

Un retrait de droits pendant le commit ne défait pas une transaction déjà engagée : son reçu est retenu et une reprise exacte après retour d'une admission valide peut le retrouver. Les erreurs connues sont des codes publics contrôlés ; les messages inconnus des ports ou d'un `LedgerError` ne sont pas retournés. Les données fiscales privées, réponses SDK, secrets et adresses ne sont pas ajoutés aux diagnostics.

## Défaut de reprise trouvé et corrigé

Le scénario PostgreSQL de reprise a découvert que l'ancienne empreinte publique utilisait `JSON.stringify` et dépendait de l'ordre d'insertion des propriétés des adresses. Le corps résolu durable est canonique ; sa reconstruction pouvait donc produire une empreinte différente pour les mêmes données, ce qui faisait échouer une reprise reserved ou calculated.

L'adaptateur national centralise désormais la sérialisation : US utilise le JSON canonique ; CH conserve exactement son ancien `JSON.stringify`. Un changement réel d'adresse, de montant net, de date ou de révision reste distinct. Les champs non fiscaux ne sont pas traduits ou altérés. La fixation d'identité ne prétend pas retirer les adresses publiques de l'empreinte fiscale préexistante.

Les anciennes factures US déjà émises exigent une compatibilité de lecture séparée. La reconstruction et l'impression historiques acceptent uniquement une variation de l'ordre des propriétés présentant le même contenu fiscal canonique. La chaîne doit aussi être celle qu'aurait produite `JSON.stringify` : variantes d'espacement, clés dupliquées, données supplémentaires, différences de valeurs ou JSON invalide sont refusés. La longueur est bornée par celle de l'empreinte attendue. La preuve, ses dates et ses montants d'origine restent inchangés. Cette compatibilité n'élargit ni `invoiceFromEstimate` pour une nouvelle émission, ni `validateStoredStripeTaxCalculation` pour une preuve pending.

## Lecteur financier et SDK

Le lecteur privé lit pays, vendeur public, déclarations fiscales privées et liaison de TEST via le vrai contrat `SupabaseServerClient`, avec Auth fraîche avant et après chaque lecture. Il copie les réponses avant la prochaine attente, vérifie leur portée, révision et horodatage, et ne déduit aucun droit d'un statut stocké. Les fixtures fiscales sont refusées par défaut. Ces quatre lectures ne constituent pas une transaction atomique ; les gardes SQL finales conservent l'autorité d'admission sous verrou.

Le helper SDK sépare le JSON métier du `lastResponse` technique attaché par Stripe 22.6. Il lit uniquement les quatre métadonnées propres ajoutées par le SDK, sans parcourir les headers, sockets, objets Response, getters ou autres propriétés hôtes. Une métadonnée présente et différente du contexte serveur est refusée. Une métadonnée absente ou correspondante n'authentifie pas une clé, un compte, le mode TEST, une origine fiscale ou une registration. Le gateway réel reste à fournir et doit observer ces éléments indépendamment.

La réponse HTTP reste exactement `{receipt, replayed}`, avec un reçu de cinq champs corrélé à la clé, au hash, à la commande et à la révision. Le hook privé optionnel ne concerne que `issue_invoice`. Les autres commandes gardent leur moteur. Les headers no-store et les contrôles Auth, origine navigateur, limite de requêtes, droits et postflight restent ceux de la route ERP existante. Aucun binding runtime ne fournit ce hook ou ce gateway par défaut ; `taxProvider()` reste `null` et les flags US fermés.

## Vérification

Les résultats finaux, empreintes et sélection exacte sont consignés dans [la preuve consolidée](../evidence/us-tax-invoice-issuer-20261008.json). Elle distingue les tests unitaires de ports injectés, les handlers HTTP réels avec admission synthétique, et la verticale PostgreSQL locale avec vraie orchestration/moteur/lecteur/transport/RPC mais Auth et fournisseur fictifs.

La régression finale exécute **2 780 tests dans 70 fichiers : tous réussis, aucun échec ni test en attente**, en environ 151 secondes. Elle comprend les trois QA navigateur antérieures, activées explicitement. TypeScript global, lint des 15 fichiers TypeScript créés ou modifiés, build de production et `git diff --check` terminent avec le code 0. Les empreintes des 15 fichiers sont identiques avant et après cette vérification. Les 133 fichiers SQL suivis, dont 22 migrations Supabase, conservent leurs blobs Git à l'identique de la base ; aucune nouvelle migration n'est ajoutée.

| Nouveau parcours vérifié | Tests réussis |
| --- | ---: |
| SDK et métadonnées hôtes | 24 |
| Lecteur financier privé | 98 |
| Orchestration, permissions et reprises en mémoire | 111 |
| Verticale PostgreSQL locale | 20 |
| Frontière HTTP et projection | 44 |
| Identité nationale des requêtes fiscales | 12 |
| Compatibilité de lecture historique | 31 |

La dernière revue a aussi découvert une perte de codes lors de la double conversion d'erreurs : les erreurs Ledger de permission, preuve expirée ou preuve stale pouvaient perdre leur code ou devenir 503. L'allowlist finale conserve leurs statuts contrôlés et normalise ceux des classes Stripe dès la première conversion, y compris pendant `revalidate`. Les codes runtime inconnus restent génériques. Les tests couvrent des statuts injectés invalides ; un premier run de 2 766 tests antérieur à ces ajouts est identifié séparément et ne sert pas de preuve du code final.

Le build signale encore la convention middleware dépréciée, certains chunks de plus de 500 kB et des routes que Vinext ne peut classifier statiquement. Le succès du build ne constitue donc pas une mesure de performance de production.

La verticale utilise une instance PGlite sérialisée en RAM. Le client Supabase reçoit un fetch local synthétique qui exécute les SQL sous `service_role` ; il ne passe pas par PostgREST hébergé. Les taux, codes fiscaux, entreprises et comptes de fournisseur de ces scénarios sont fictifs. Ce n'est ni une observation Stripe, ni une détermination fiscale, ni une preuve de concurrence entre deux connexions, de durabilité après crash ou de capacité de production.

Les QA navigateur déjà existants sont repris par la régression ; aucune nouvelle interface navigateur d'émission ou session hébergée n'est revendiquée. Les consommateurs CH sélectionnés ne constituent pas une recette de chaque fonction native, des QR-factures sur appareil ou des paiements réels. Les tentatives précédentes d'accès à une sandbox contrôlée restent sans preuve de provision exploitable ; aucune clé abandonnée ou de production n'est réutilisée.

## Fichiers de cette étape

Créés :

- `lib/international/us-tax-invoice.ts`, ses tests unitaires et `us-tax-invoice.postgres.test.ts`.
- `lib/international/us-tax-financial-context.ts` et son test.
- `lib/international/stripe-tax-sdk-body.ts` et son test.
- `lib/international/runtime-server-us-tax.test.ts`, `tax-request-identity.test.ts` et `tax-request-history.test.ts`.
- Ce rapport et sa preuve consolidée.

Modifiés :

- `lib/international/runtime-server.ts` : hook optionnel privé, refus des rôles non financiers et projection stricte du reçu.
- `lib/international/countries/adapters.ts`, `invoicing.ts` : identité nationale stable et reconstruction historique séparée.
- `lib/international/runtime-validation.ts`, `documents.ts` : utilisation de la compatibilité uniquement pour lire et imprimer des documents déjà émis.

Migrations nouvelles : aucune. Les migrations suivies à la base doivent rester identiques dans la preuve finale.

## Risques et suite

Terminé localement : orchestration de TEST, admission privée du rôle réel, reprise exacte, projection HTTP, compatibilité historique et séparation du SDK. Expérimental : toute cette émission US, le gateway réel, les registrations/classifications vérifiées et l'activation pour un client.

Le gateway `verify` est invoqué plusieurs fois pour la fraîcheur des observations. Sa latence et son coût doivent être mesurés lorsqu'un vrai transport existera. Les lectures composées ne garantissent pas zéro appel fournisseur devenu stale pendant une modification concurrente ; le contrôle final SQL empêche de finaliser l'ancienne facture. Un échec Stripe rejoué par idempotence n'est pas présenté comme toujours récupérable.

Prochaine étape : établir une sandbox contrôlée, vérifier identité du compte de vendeur, TEST/API, Tax Settings et correspondance de `head_office.address` avec l'origine déclarée, registrations et classifications réelles ; injecter un gateway sans utiliser le compte d'abonnement SaaS comme vendeur. Tester ensuite le calcul réel, sa reprise et son commit depuis le parcours HTTP/interface. Transactions fiscales après émission, reversals/avoirs, biens/exemptions, paiements clients, abonnements USD, workflows Support/Automation et modules ERP manquants restent des phases distinctes. Aucune certification US GAAP ou garantie de conformité n'est annoncée.

Retour arrière : retirer le hook et les nouveaux parcours, conserver les flags fermés ainsi que les preuves, reçus, audits et données. Ne pas supprimer ou réécrire des documents engagés, ni réautoriser une émission sans preuve. Staging, deux connexions réelles, recette appareils et approbation explicite précèdent toute modification de production.

## Sources primaires

- [Stripe Tax — retrieve settings](https://docs.stripe.com/api/tax/settings/retrieve), [list registrations](https://docs.stripe.com/api/tax/registrations/list), [retrieve tax code](https://docs.stripe.com/api/tax_codes/retrieve) — documentation consultée avec le CLI officiel ; aucune observation du compte.
- [Calculations API](https://docs.stripe.com/api/tax/calculations/create), [idempotent requests](https://docs.stripe.com/api/idempotent_requests) — paramètres et limites des reprises.
- SDK Stripe installé `22.6.0`, `RequestSender` et schémas Tax, version API `2026-08-26.dahlia`.
- [Supabase database functions](https://supabase.com/docs/guides/database/functions) — RPC, privilèges et exécution des fonctions ; le changelog actuel a aussi été consulté, sans mise à niveau d'une base hébergée.
