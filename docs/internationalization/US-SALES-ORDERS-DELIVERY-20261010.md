# Commandes clients US — livraison locale du 10 octobre 2026

Jalon incrémental de la phase C, sur la base locale `ea4613b`. Ce document décrit le registre commercial US ajouté au repository ; il n'annonce ni activation client, ni migration hébergée, ni livraison native. Les flags de ce jalon sont fermés par défaut. Les preuves ciblées et la recette finale sont distinguées ci-dessous.

## 1. Résumé des modifications

Un devis accepté peut servir de source à une commande US numérotée. PostgreSQL prend lui-même la copie du devis, de son client, de ses lignes et des coordonnées publiques du vendeur ; le navigateur transmet les identifiants et révisions attendues, jamais un document financier faisant autorité. La commande peut être confirmée en interne ou annulée explicitement. Son numéro, ses snapshots, ses auteurs, ses dates, ses références, son audit et ses reçus idempotents sont conservés.

Le registre commercial est distinct du livre ERP et ne crée aucun protocole ERP v5. Il propose des pages de 25 commandes, un détail, une tête compacte et une recherche de source indépendante de la page courante. Le workbench réutilise les thèmes clair/sombre et les traductions FR/EN/DE/IT, avec des présentations adaptées au mobile et à l'ordinateur. Un aperçu local utilise uniquement des données fictives.

L'admission serveur vérifie l'entreprise US/USD, le schéma 4 actuel, l'identité, le rôle et le droit Gestion ; Automation n'est pas requis. Les lectures et les écritures revalident les droits et la configuration après les attentes privées. Les exports JSON, HTML, CSV et PDF sont liés à une révision exacte de commande et relisent le document après le rendu. Ils ne contiennent ni EIN, ni secret, ni preuve privée du fournisseur fiscal.

La commande affiche un total commercial hors taxe avec une taxe restant à déterminer. Créer, confirmer ou annuler ne génère aucun journal, paiement, livraison ou détermination fiscale. Une facture déjà émise n'est pas annulée par une annulation commerciale. Le parcours de facturation existant conserve ses permissions financières et ses propres contrôles fiscaux.

## 2. Fichiers créés

Inventaire des sources ajoutées pour ce jalon, chemins relatifs au repository. Les preuves générées dans `.qa` ne sont pas des sources applicatives.

| Groupe | Fichiers |
| --- | --- |
| Contrat et persistance | `lib/international/us-sales-order-contract.ts`, `lib/international/us-sales-order-store.ts` |
| Tests backend | `lib/international/us-sales-order-contract.test.ts`, `lib/international/us-sales-order-store.test.ts`, `lib/international/us-sales-order.postgres.test.ts` |
| Admission HTTP | `lib/international/us-sales-order-server.ts`, `lib/international/us-sales-order-server.test.ts`, `lib/international/us-sales-order-bindings.ts`, `lib/international/us-sales-order-bindings.test.ts` |
| Routes | `app/api/international/workspaces/[organizationId]/sales-orders/route.ts`, `app/api/international/workspaces/[organizationId]/sales-orders/[salesOrderId]/route.ts`, `app/api/international/workspaces/[organizationId]/sales-orders/[salesOrderId]/export/route.ts` |
| Documents commerciaux | `lib/international/us-sales-order-export.ts`, `lib/international/us-sales-order-export.test.ts` |
| Transport et messages | `lib/international/browser-us-sales-order-session.ts`, `lib/international/browser-us-sales-order-session.test.ts`, `lib/international/browser-us-sales-order-copy.ts` |
| Interface | `components/account/us-sales-orders.tsx`, `components/account/us-sales-orders.css` |
| Tests des gardes ERP | `lib/international/us-sales-order-erp-guard.test.ts` |
| Aperçu fictif | `tests/us-sales-orders-fixture.ts`, `tests/us-sales-orders-preview.tsx`, `tests/us-sales-orders-preview.html` |
| Migration | `supabase/migrations/20261010054644_international_us_sales_orders.sql` |
| Documentation | `docs/internationalization/US-SALES-ORDERS-PLAN-20261010.md`, `docs/internationalization/US-SALES-ORDERS-RESEARCH-20261010.md`, ce document |
| Preuves conservées | `docs/evidence/us-sales-orders-20261010.json` et dossier `docs/evidence/us-sales-orders-20261010/` : matrice, interactions, captures et documents commerciaux fictifs rendus |

## 3. Fichiers modifiés

| Fichier | Modification du jalon |
| --- | --- |
| `app/compte/espaces/us/[organizationId]/page.tsx` | Lecture de disponibilité et transmission séparée des droits d'historique et de nouvelles commandes. |
| `components/account/us-erp-workbench.tsx` | Intégration du registre, coordination des états occupés/incertains, invalidation des accès et messages des gardes de source/facturation. |
| `components/account/us-tax-invoice-panel.tsx` | Explication traduite du blocage commercial dans le parcours fiscal préparé. |
| `lib/international/browser-erp-session.ts` | Reconnaissance des conflits commerciaux certains, sans reprise aveugle d'une transaction rejetée. |
| `lib/international/browser-us-tax-invoice-session.ts` | Même distinction des conflits de source et de commande dans le transport fiscal. |
| `lib/international/runtime-store.ts` | Traduction publique et bornée de `PO008` et `PO011` renvoyés par les gardes SQL. |
| `lib/account-workspace-pages.test.ts` | Mock de disponibilité dédié aux commandes et couverture de la transmission des flags, du schéma 4, des changements de session/droits et des destinations sans ce module. |
| `docs/internationalization/STATUS-20261009.md` | Actualisation de la phase C, distinction avec les relevés antérieurs et liste des prochaines verticales. |

Les fichiers suisses, les migrations précédentes et les formats ERP 1–4 ne sont pas réécrits pour créer un format de commande partagé.

## 4. Migrations proposées et retour arrière

Une migration additive versionnée est proposée : `20261010054644_international_us_sales_orders.sql`. Elle a été exécutée avec les migrations préalables dans PostgreSQL local embarqué/PGlite sur des données fictives. Elle n'a pas été exécutée dans Supabase hébergé ou en production.

Elle ajoute quatre tables : `zentra_us_sales_order_heads`, `zentra_us_sales_orders`, `zentra_us_sales_order_receipts` et `zentra_us_sales_order_audit`. Elles conservent compteur, révisions, commande active unique par devis, reçus exacts et historique. La RLS reste activée ; les rôles `anon` et `authenticated` n'obtiennent pas d'accès direct. Les ports RPC sont privés, `security invoker`, et nécessitent l'admission Auth/D1/Gestion du serveur. Le service privilégié n'est pas une autorisation utilisateur : le serveur doit toujours vérifier l'entreprise et les droits avant et après ses appels.

Les RPC ajoutés couvrent tête, source, liste, détail, reçu et exécution. L'exécution verrouille les têtes ERP et commerciale dans un ordre constant, compare les révisions attendues et effectue la transition, le reçu et l'audit dans la même transaction. Les gardes supplémentaires protègent les snapshots et la source ERP :

- `PO008` bloque la modification d'un devis rattaché à une commande active. Le parcours ERP expose `sales_order_source_locked` (409), puis permet une annulation explicite et une nouvelle lecture.
- `PO011` bloque la facturation d'une commande non confirmée ou d'une source non concordante. Le parcours ERP expose `sales_order_invoice_blocked` (409). La transaction refusée ne conserve ni facture, ni journal, ni compteur ni reçu partiel.

Deux flags distincts restent désactivés par défaut : `INTERNATIONAL_US_SALES_ORDERS_ENABLED` ouvre création/confirmation ; `INTERNATIONAL_US_SALES_ORDERS_HISTORY_ENABLED` conserve lecture/export/annulation et récupération d'un reçu exact. La capacité actuelle du schéma 4, l'édition US/USD et le runtime ERP sont également nécessaires.

Retour arrière prévu : fermer les nouvelles commandes, conserver l'historique et le code de consultation/annulation ainsi que la traduction des gardes, et revenir sur la présentation si nécessaire. Conserver tables, reçus, audit et triggers. Les protections SQL ne disparaissent pas avec les flags ; fermer tout l'historique laisserait les devis protégés sans parcours d'annulation visible. Aucun `DROP`, effacement ou réécriture de migration n'est proposé. Toute application hébergée de cette migration attend une approbation explicite.

## 5. Tests exécutés et résultats ciblés

Recette finale locale sur l'implémentation **`aaba17ee4abd51e142c4fd04043bc52026139308`** : **4 255/4 255 tests réussis dans 133 fichiers**, aucun échec, skip ou todo. La sélection conserve les 125 fichiers de la précédente non-régression CH/US. Huit fichiers nouveaux comportent 259 tests ; les tests de page ajoutent 18 cas, soit 277 tests supplémentaires. La frontière RPC simulée des 9 gardes ne remplace pas les 19 tests exécutant réellement PostgreSQL local.

TypeScript global, lint typé des 28 fichiers TypeScript concernés avec avertissements refusés, vérification de marque et build de production réussis. Les notices existantes de vinext sur les conventions middleware, le timing des plugins et la classification des routes ne sont pas des erreurs de compilation. La dernière mise en ordre d'une déclaration de fonction, nécessaire au compilateur React du lint, ne change pas le comportement ou le rendu capturé ; lint, types et build passent après cette correction.

Le premier passage global a révélé 31 échecs dans le mock de page ancien. Sa mise à jour et les tests supplémentaires ont fait ressortir un raccordement manquant des props du workbench, corrigé avant la recette finale. Les autres scénarios conservent leurs résultats. Les rapports ciblés se recouvrent et ne sont pas additionnés au total final. Les empreintes des sources, rapports et 54 artefacts sont consignées dans `docs/evidence/us-sales-orders-20261010.json`.

Les chiffres ciblés suivants sont inclus dans la régression finale ; ils ne s'ajoutent pas à son total. Les transports simulés, le vrai PostgreSQL local et la recette navigateur sont distingués.

| Suite ciblée | Résultat | Preuve et portée |
| --- | --- | --- |
| Contrat, store et PostgreSQL local | **78/78 réussis** | Résultat de l'agent backend : contrats stricts, migration sur PGlite, privilèges, transactions, révisions, idempotence, snapshot, annulation, source hors page 25, lecture `read_only`, protection du témoin CH et vraie chaîne de facturation préparée TEST. La détermination fiscale est synthétique ; aucun fournisseur réel n'est appelé. |
| HTTP | **93/93 réussis**, aucun ignoré | `.qa/us-sales-order-http.json` ; admission, origine navigateur, bearer natif simulé, identité attendue, rôles, révocation, changements de gates/configuration/capacité, bornes, liste/source/détail, reprise après résultat ambigu, exports et contrôle après rendu. Auth et persistance de cette suite utilisent des ports de test, pas un compte hébergé. |
| Exports | **20/20 réussis**, aucun ignoré | `.qa/us-sales-orders/export-tests.json` ; snapshots stricts, cents exacts, quatre langues, échappement HTML, CSV neutralisant les formules, PDF Letter réel, longues lignes/notes et annulation. Les preuves de lecture indépendante et de rendu sont dans `.qa/us-sales-orders/exports/renderer-proof.json` et `visual-proof.json`. |
| Gardes ERP via stores, HTTP et transports | **9/9 réussis** | Résultat ciblé du responsable de phase pour `us-sales-order-erp-guard.test.ts` : `PO008`, `PO011`, cash/accrual, annulation puis relecture, aucune permission financière ajoutée aux membres, absence de données privées et de transaction partielle. La frontière RPC renvoie ici des SQLSTATE simulés ; cette suite ne prétend pas appliquer la migration. |
| Bindings/readiness | **21/21 réussis** | Flags exacts et fermés par défaut, historique seul, schéma courant, retrait des gates après attente et construction différée du store ; ports runtime simulés. |
| Pages d'espaces | **95/95 réussis**, dont 18 nouveaux | Transmission des deux disponibilités au workbench US, schéma 4, refus de montage après changement de session/rôle/droits et absence du module sur les autres destinations. |

La recette navigateur du vrai composant et de son transport couvre **24 compositions** : FR/EN/DE/IT, clair/sombre et 320/390/1 440 pixels. Aucun débordement de page ou de section observé ; les boutons mesurés respectent 44 pixels dans les deux dimensions. Les contrastes des textes échantillonnés sont au minimum 5,60:1 en clair et 9,40:1 en sombre. Les données, Auth et réponses HTTP de cet aperçu sont fictives. Les exports y sont volontairement indisponibles ; leur rendu réel est couvert séparément.

Douze observations fonctionnelles sont conservées dans `docs/evidence/us-sales-orders-20261010/functional.json` : réponse interrompue, reprise sans doublon, annulation/historique, nouvelle commande après annulation, modification distante conservant le brouillon et bloquant l'action périmée, fermeture conservée après actualisation, révocation, source réservée hors page, lecture seule, changement de compte, pause conservant les annulations et focus visible de 3 pixels. Aucun avertissement ou erreur console observé dans cette recette locale.

Les corrections finales conservent les erreurs pendant la relecture, renouvellent la source sélectionnée sans perdre date/référence, désactivent brièvement les actions pendant une actualisation silencieuse et rétablissent l'autorité après les refus certains PO008/PO011. Les tests de page ont également détecté et corrigé la transmission des deux disponibilités au workbench réel. Le focus est guidé vers le champ utile, sans panneau de chargement durant la réception des modifications.

## 6. Risques identifiés et limites

- Une confirmation interne n'est pas une signature du client ni une garantie contractuelle. Les hypothèses et sources réglementaires sont documentées dans le relevé de recherche ; aucune certification US GAAP n'est annoncée.
- Une taxe inconnue reste à déterminer. Le document ne présente ni une taxe de zéro, ni une exemption, ni un total final fiscal. Les acomptes et méthodes cash/accrual restent distincts.
- Les protections SQL continuent après fermeture des nouvelles commandes. Le retour arrière doit préserver le parcours d'historique/annulation ; un ancien client peut sinon afficher un conflit moins explicite, sans que ce conflit autorise à effacer la protection.
- Un échec de réseau ou de revalidation après un envoi peut suivre une écriture déjà validée. Le transport conserve alors la commande exacte pour une reprise idempotente ; modifier son contenu ou générer un autre identifiant ne serait pas une récupération sûre.
- Les tests locaux ne prouvent pas une session Auth réelle, une configuration de worker hébergé, les gates de déploiement, le transport d'un appareil physique ou la charge en production. Ces vérifications restent à réaliser avant activation.
- Le registre et ses exports bornent pages, messages et documents. Une pagination sans plafond de durée de vie ne constitue pas une validation de capacité de production à grande échelle.
- La migration requiert les schémas et fonctions des jalons US précédents. Appliquer seulement ce fichier sur une base non préparée n'est pas un déploiement pris en charge.

## 7. Fonctionnalités terminées dans ce jalon local

- Contrats typés stricts et projections privées contrôlées, séparés des formats ERP existants.
- Création depuis un devis accepté, numérotation atomique, confirmation interne, annulation, reçu exact, audit et protection des révisions.
- Liste paginée, tête compacte, recherche directe de source, détail et lien de facture corroboré.
- Admission HTTP commerciale US/Gestion, rôles, contrôle de session et origine, gates séparés et revalidation des données privées.
- Exports commerciaux JSON/HTML/CSV/PDF liés à la révision choisie, hors taxe, US Letter et FR/EN/DE/IT.
- Transport navigateur avec invalidation d'accès, conflits certains et reprise d'une opération dont le résultat est incertain.
- Intégration du registre et des explications de blocage dans le workbench, avec aperçu fictif et recette mobile/ordinateur, langues et thèmes exécutée.

« Terminées » signifie implémentées avec les preuves ciblées décrites ci-dessus, pas activées pour les clients.

## 8. Fonctionnalités expérimentales ou restant à valider

Le registre US est un pilote local fermé par défaut. La configuration d'un environnement hébergé de test et la validation du retour arrière opérationnel restent nécessaires avant toute ouverture. Les essais locaux décrits ici ne remplacent ni l'Auth hébergée ni un appareil physique.

La signature/acceptation client, les révisions contractuelles, acomptes, avoirs, remboursements, récurrences, livraisons, bons de livraison et exécution de marchandises ne sont pas ajoutés par ce jalon. La facture utilise les parcours existants ; aucune commande ne déclenche automatiquement encaissement, email sensible ou workflow Automation.

Aucun tarif Stripe, abonnement CHF/USD, donnée client, région Supabase, secret de production ou réglage global n'est modifié. Aucune migration hébergée, activation réelle, compilation ou publication Windows/macOS/iOS/Android n'a été effectuée pour cette livraison locale.
