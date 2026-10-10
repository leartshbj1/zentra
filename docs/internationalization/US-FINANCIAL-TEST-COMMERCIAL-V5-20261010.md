# Zentra US — continuité commerciale PostgreSQL privée TEST V5

10 octobre 2026. **Jalon local privé TEST validé.** Ce jalon poursuit le même ERP et le même livre financier. Il ne publie aucune route/interface, ne migre aucune base hébergée et ne change aucun contrat public ERP1–4, client suisse, abonnement ou installateur.

Suite locale validée : `US-FINANCIAL-TEST-PURCHASING-V5-20261010.md` ajoute le cycle fournisseur sous une capacité cumulative distincte. Les résultats ci-dessous restent ceux de ce jalon commercial, non augmentés rétroactivement. Son ancien port refuse désormais toute queue achats avant replay, tandis que le nouveau port conserve la continuité commerciale.

## 1. Modifications

La capacité distincte `postgres-test-commercial-v5` permet de créer/modifier un client, créer/modifier un devis et accepter un devis après promotion financière. Elle conserve les avoirs et encaissements déjà admis. Fournisseurs, projets nouveaux, achats, journaux manuels, périodes et émission de nouvelles factures restent refusés par ce port, avant tout RPC ou prestataire côté runtime et indépendamment en SQL.

Les événements commerciaux et financiers partagent la même baseline immuable, le même historique et le même curseur. PostgreSQL reconstruit chaque opération depuis son préfixe validé. Il ne conserve pas une seconde comptabilité courante. Une opération commerciale avance la révision métier, sans ajouter d'écriture ni d'audit comptable. Les clients déjà inscrits sur les anciens devis/factures restent des snapshots historiques. Les modifications successives du même client ou devis conservent les identités, numéros et compteurs selon le moteur existant.

Un en-tête ERP4 temporaire sert uniquement à vérifier le commit commercial capturé ; il omet les écritures d'avoir dans cette compatibilité interne et compte les paiements. Le ledger réel V5 conserve tous ses avoirs et règlements. Le reçu externe V5 et le reçu ERP interne ont chacun leur hash canonique propre ; aucun ne se substitue à l'autre.

Les deux adaptateurs PostgreSQL partagent désormais des mécaniques privées de capture/revalidation, exposées seulement par deux factories nommées à profil constant. Le port settlement reste fermé aux événements ERP et refuse explicitement un livre qui en contient, avant tout replay incompatible. Le store mémoire conserve ses capacités antérieures.

## 2. Fichiers créés

- `lib/international/us-financial-test-store.ts` : mécaniques privées communes, profils fermés et mapping PO008.
- `lib/international/us-financial-test-commercial.ts` : entrée nommée du nouveau port.
- `lib/international/us-financial-test-commercial.test.ts` : moteur réel avec transport RPC fictif, capacités, reçus et autorité.
- `lib/international/us-financial-test-commercial.postgres.test.ts` : chaîne réelle de migrations/RPC locales avec données fictives.
- `supabase/migrations/20261010085523_international_us_financial_test_commercial_v5.sql` : migration additive créée avec la CLI.
- Plan `US-FINANCIAL-COMMERCIAL-PERSISTENCE-V5-20261010.md`, cette livraison et preuve `docs/evidence/us-financial-commercial-v5-20261010.json`.

## 3. Fichiers modifiés

- `lib/international/us-financial-kernel-runtime.ts` : nouvelle capacité fermée et classifier canonique des trois commandes commerciales ; grants financiers TEST conservés.
- `lib/international/us-financial-test-settlement.ts` : réexport de sa factory existante depuis les mécaniques communes ; API inchangée.
- Documents de statut/persistance et note de suite du jalon settlement : état cumulatif après recette.

Ni le moteur ERP existant, ni les types de schéma public, ni les migrations historiques, ni les sources CH/UI/natives ne sont modifiés.

## 4. Migration et retour arrière

La migration utilise les tables financières existantes, sans nouvelle table de projection mutable. Elle verrouille et valide les livres settlement présents, leurs plans, curseurs et reçus avant de remplacer les gardiens. Elle refuse une installation incompatible, sans réécrire ni nettoyer l'historique. Les nouveaux RPC et helpers restent `SECURITY INVOKER`, avec search_path vide et accès PUBLIC/anon/authenticated révoqué. Le rôle serveur demeure une autorité de confiance ; il ne peut pas provisionner ses grants ou plans fiscaux.

Pour les nouveaux changements de devis, la garde PO008 lit les commandes du même espace sous le verrou workspace existant. Une source liée à une commande active reste protégée. Cette admission vivante n'est pas rejouée pour vérifier un ancien événement ou retrouver un reçu historique. Les commandes legacy restent gelées après promotion ; ce jalon ne fournit donc pas encore leur annulation V5.

CAS de révision/empreinte, reprise exacte avant le CAS courant, index commun des clés réservées, autorité/grant vivants, contrôle d'horloge et complétude différée événement/reçu/curseur restent obligatoires. Promotion et premier append sont toujours dans deux transactions distinctes. Les montants restent des chaînes décimales canoniques, traitées par `NUMERIC`/`BigInt` ; aucune arithmétique financière en flottants.

Retour arrière proposé, non exécuté : révoquer les grants avec une version supérieure et conserver le livre, les reçus et le marqueur de promotion. Une fois une queue commerciale écrite, ne pas rétablir un lecteur settlement qui l'ignore et ne pas rouvrir ERP4 ; corriger par une migration additive. L'inventaire/ACL réels et la validation explicite restent nécessaires avant toute adoption hébergée.

## 5. Validation exécutée

Résultat final : **4 875 / 4 875 tests dans 146 fichiers**, aucun échec, skip ou todo ; les 144 fichiers du jalon précédent sont conservés. Les **25 nouveaux tests adaptateur** et **24 nouveaux tests PostgreSQL** sont inclus dans ce total. Les premiers utilisent le vrai moteur avec transport RPC fictif ; les seconds exécutent 27 migrations antérieures, une vraie émission locale de facture fiscale TEST et un avoir settlement préexistant, puis la nouvelle migration. Les données et observations sont fictives, sans appel réseau à un prestataire.

Le parcours exercé comprend avoir → modifications de client → devis/acceptation → encaissement → autre devis → second avoir. Les révisions métier/comptables, snapshots, numéros, compteurs, soldes et reçus sont comparés au moteur réel. Des falsifications de commits, effets, en-têtes, reçus ou scopes sont refusées atomiquement. Le CAS séquentiel, les anciennes clés réservées, grants révoqués/versionnés, rôle/tenant/horloge invalides, ACL réelles anon/authenticated, inserts incomplets et fermeture/réouverture propre du même NodeFS sont vérifiés.

Un devis peut référencer un projet baseline actif du même client ; un projet absent, archivé ou d'un autre client est refusé. Une garde de source instrumentée pour lever PO008 prouve que lecture, reçu et reprise exacte ne la consultent pas, tandis qu'un nouvel append la consulte. Le premier test d'installation conserve exactement le livre settlement présent ; il ne démontre pas à lui seul toutes les variantes de corruption d'une ancienne base. Les 144 suites antérieures sont rejouées dans leurs propres environnements locaux : cela ne constitue pas une recette d'installation hébergée ou native CH.

TypeScript global sans cache incrémental, lint typé des six fichiers TS avec warnings refusés, contrôle de marque et build production réussis. Le build utilise les sources finales runtime/store ; seuls des ajouts SQL/tests PostgreSQL ont suivi. Les commandes et empreintes figurent dans la preuve JSON. Aucun nouvel essai UI/natif n'est revendiqué puisqu'aucune surface publique n'est changée.

Les échecs intermédiaires sont conservés : spies absents du retour du fixture adaptateur, vérification TypeScript pendant l'écriture inachevée du test PG, puis helper de test inutilisé au lint. La revue a fait renforcer l'identifiant canonique et les blancs ECMAScript des lignes ; l'ordre de registre a été vérifié contre `applyErpDelta`. Les sources corrigées ont passé les contrôles finaux. Le lint Supabase CLI local n'est pas annoncé comme exécuté : absence de serveur 127.0.0.1:54322 déjà constatée lors de la fondation ; aucun serveur Docker/PG ajouté depuis. Aucun inventaire/advisor/db pull hébergé n'est substitué.

## 6. Risques et limites

- PGlite vérifie le SQL local et les transactions séquentielles. Il ne démontre pas les courses multiconnexions, la résistance au crash, les deadlocks ou un SLA.
- Revalidation serveur et grant PostgreSQL TEST ne sont pas une transaction distribuée D1/Auth/Stripe. Un refus postflight après append ne prouve pas l'absence de commit ; la clé permet sa résolution exacte.
- Replay intégral et budgets restent bornés. Pas de preuve de capacité à 150 entreprises ou d'historique illimité.
- Le gel legacy et la restriction administrative globale de TRUNCATE héritée, y compris CH/non promues, restent des contraintes d'exploitation à examiner avant hébergement.
- Plans fiscaux locaux TEST, sans observation de reversal fournisseur, remboursement, taux inventé ou certification US GAAP.

## 7. Terminé dans ce jalon

Continuité clients/devis/acceptation/avoirs/encaissements sur un seul historique PostgreSQL privé TEST, reconstruction indépendante, snapshots/compteurs exacts, reprises historiques, persistance après fermeture propre et protections de source. Les anciens ports restent explicitement bornés ; aucun fallback ne présente une baseline figée comme état courant.

## 8. Expérimental et suite obligatoire

Le port reste privé/local/TEST, avec grants explicites et données fictives. Il ne constitue pas l'ERP US commercial terminé. Restent le raccord fournisseurs/projets/achats, journaux/périodes, nouvelle facture et preuves fiscales courantes, sidecars du même livre, projections/exports, UI/natifs, remboursements/acompte/récurrence/livraison/cash basis, workflows Support/Automation et recette hébergée approuvée. L'objectif international complet reste actif.
