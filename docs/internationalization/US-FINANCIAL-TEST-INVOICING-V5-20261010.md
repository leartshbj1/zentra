# Zentra US — émission de factures dans le livre financier V5

10 octobre 2026. **Livraison locale privée TEST.** Implémentation `41df1a70b32f7196caeec553bc04bccc488198d4`, base `9eafe8b`. Preuve : `docs/evidence/us-financial-invoicing-v5-20261010.json`. Aucun déploiement, changement hébergé, appel fournisseur ou publication native. Le chantier ERP US complet reste actif.

## 1. Modifications

La capacité privée `postgres-test-invoicing-v5` ajoute l'émission client aux dix commandes ERP du lot comptable, aux avoirs et aux encaissements. Elle conserve la même baseline immuable, les mêmes événements, reçus, grants, curseur et CAS. Pas de second ledger ni de faux `ErpState4` courant. PostgreSQL reconstruit indépendamment facture, compteur, snapshots, vrai journal AR/revenu/taxe, audit et reçu ; révision financière, comptable et compatible restent distinctes.

Un nouveau resolver fiscal et son store gardent séparés contexte marchand privé, préparation et opération durable. Le contexte est provisionné seulement par le DB-owner, sans secret API. Il conserve l'origine `test_fixture` avec opt-in explicite ; aucun renommage en `provider_observation`. La configuration baseline doit déjà être US/USD/accrual et fiscalement préparée. Les profils manquants ou non configurés sont refusés.

Préflight SQL sur source courante avant tout nouveau catalogue/gateway, réservation durable avant calcul injecté, puis preuve conservée et append atomique. Le devis accepté, sa révision et son contenu, configuration, vendeur, localisation, classifications confirmées et instant fiscal sont liés par les deux hashes distincts — requête financière extérieure et requête ERP intérieure. Une reprise ne change ni numéro, ni paramètres, ni clé fournisseur, ni fenêtre d'origine.

Le registre courant comprend les nouvelles factures et leurs paiements comptés une fois. Les avoirs restent distincts : le scénario TS vérifie **32 475 = 1 000 reçus + 10 825 crédités + 20 650 restant**, en minor units USD, sur le vrai ledger. Un avoir ne devient pas un encaissement.

La revue a corrigé la parité TS/SQL des horloges, UUID, ordre des lignes de preuve, juridictions canoniques et `projectId` facultatif. Une fenêtre de contexte historique ne dépasse pas 120 secondes ; les relations observation/admission/préparation/réservation/calcul et l'instant fiscal sont vérifiées aux horloges stockées. Les clocks et tolérances TEST ne constituent pas des règles fiscales américaines.

## 2. Fichiers créés

- `lib/international/us-financial-test-invoicing.ts` : entrée explicite de la capacité.
- `lib/international/us-financial-invoice-test.ts` : contrats privés, validations et resolver.
- `lib/international/us-financial-invoice-test-store.ts` : capture, revalidation et RPC fiscaux privés.
- `lib/international/us-financial-invoice-test.test.ts` : moteur réel avec transport RPC/gateway explicitement fictifs.
- `lib/international/us-financial-test-invoicing.postgres.test.ts` : recette PostgreSQL locale réelle.
- `supabase/migrations/20261010100252_international_us_financial_test_invoicing_v5.sql` : migration additive, créée via CLI selon le journal d'implémentation, non exécutée en hébergement.

Ce document et la preuve finale sont enregistrés séparément des huit sources de l'implémentation.

## 3. Fichiers modifiés

- `lib/international/us-financial-kernel-runtime.ts` : capacité et allowlist fermée accounting + `issue_invoice`.
- `lib/international/us-financial-test-store.ts` : profil nommé, validation de queue et PO011 ; capture du port RPC avant les awaits, vérifiée par une recette de remplacement de méthode.

Réutilisation des moteurs existants de facture, ledger, source fiscale, paramètres et preuve de calcul. Contrats publics ERP1–4, anciens fichiers de migration, UI, routes, tarifs, domaines, Suisse et sources natives inchangés.

## 4. Migration et retour arrière

Prévalidation des livres/plans/curseurs/reçus existants sous verrous, remplacement additif du replay et revalidation avant COMMIT. Aucune histoire réécrite. Les réservations nouvelles sont contrôlées contre reçus financiers, registres V5, anciennes préparations/opérations fiscales, ID de facture/opération et clé fournisseur. Les nouvelles mutations et INSERT directs partagent ces contrôles ; une collision historique déjà valide n'est pas refusée rétroactivement.

PO011 est contrôlé explicitement avant nouveau calcul et à l'append : absence d'ordre actif admise, sinon ordre confirmé et source exacte, avec chronologie compatible. PO008 reste appliqué aux mutations concernées. Les reprises historiques exactes lisent d'abord le reçu et ne dépendent pas d'un contexte marchand frais, d'un nouvel ordre ou d'un autre calcul.

L'opération `reserved → calculated → committed` est liée à l'événement, au reçu et au curseur par les gardes et triggers différés. Une insertion financière directe laissant l'opération non committée annule la transaction. Contextes, préparations et identités d'opérations sont immuables ; RLS, invoker/search_path vide et grants TEST vivants conservés. L'ACL UPDATE nécessaire à `SELECT FOR UPDATE` ne donne pas le droit de modifier un contexte : le trigger refuse sa mutation, y compris administrative.

Tous les anciens profils financiers refusent la nouvelle queue d'émission avant replay/read/receipt ; aucun reader fiscal ou sidecar ERP4 n'est rouvert. Retour arrière non exécuté : fermer les opt-in et grants versionnés, conserver lecteur compatible et histoire, réparer additivement. Pas d'effacement de queue ni fallback sur la baseline. Toute migration hébergée reste soumise à approbation explicite.

## 5. Tests réellement exécutés

Régression finale : **5 144 / 5 144 tests dans 152 fichiers**, aucun échec, skip ou todo ; les 150 fichiers précédents sont conservés. Les **50 tests unitaires et 24 tests PostgreSQL** nouveaux sont inclus dans ce total. Exécution complète en 229 769 ms sur les huit sources finales.

Types globaux non incrémentaux, lint typé des sept fichiers TS avec refus des warnings, vérification des assets de marque et build de production : **exit 0** chacun. L'arbre complet de 3 465 fichiers sources, ainsi que les huit hashes ciblés, est identique avant/après les contrôles et à l'implémentation enregistrée. Le build n'est pas déployé.

Le passage ciblé antérieur de 208 tests dans quatre fichiers est un sous-ensemble de la régression finale, non un total additionnel.

La recette PostgreSQL installe **30 migrations antérieures puis la 31e** sur un historique de crédit existant. Elle vérifie nouvelle facture, deux paiements, avoir, crédit/journal/clôture/ouverture puis nouvelle émission, PO011, collisions legacy/V5, hashes extérieur/intérieur, preuves/texte/horloges, insertion directe, anciennes capacités, grant/rôles/tenant, reprises et atomicité des refus. Une vraie réservation legacy pendante est créée avant promotion ; une collision déjà valide avant installation reste lisible et rejouable.

Fermeture/réouverture propre NodeFS vérifiée, répertoire ciblé conservé `D:/Codex-Zentra-Temporary/2026-10-08/native-admission-temp/zentra-invoicing-test-v5-J5k93n`. Le passage ciblé 24/24 a précédé une assertion TS supplémentaire, vérifiée alors par 1/1 avec 23 skips ; la régression finale exécute bien tous les 24 sur les sources finales. Aucun ajout de ces comptes au total final.

Le recorder corrobore comptes, statuts, sélection, hashes, commandes et arbre de sources complet. Les faits spécifiques migration/NodeFS/rollback sont liés aux assertions nommées réussies et à la revue de leur code, sans prétendre interpréter automatiquement leurs corps. Création CLI attestée par l'exécution d'implémentation, non rejouée par le recorder. Les rapports/logs sont hachés. Revue readonly indépendante sans défaut bloquant supplémentaire sur les hashes finaux ; elle n'a pas relancé les tests.

Avant la recette finale, une duplication d'un bloc SQL par substitution JS et une ambiguïté PL/pgSQL `receipt` ont été corrigées. Un TSC intermédiaire réel a échoué sur trois affectations readonly de fixtures, remplacées avant les contrôles finaux. Ces échecs intermédiaires ne sont pas annoncés comme des succès. Le lint CLI Supabase local reste non validé faute de serveur `127.0.0.1:54322`/Docker ; aucun contrôle hébergé ne le remplace.

## 6. Risques et limites

Le périmètre fiscal reste services taxables exclusifs, quantités entières positives, destination US et limites déjà admises du prestataire. Aucun taux d'État, nexus, exemption ou obligation de collecte inventé. Les calculs sont fictifs : une validation de protocole ne prouve ni taxe légalement applicable, ni compte marchand réel, registration ou conformité US GAAP.

Un `taxcalc_…` est un calcul, pas une Tax Transaction, une déclaration ou un reversal. Un avoir taxé exige encore son propre plan privé admissible ; aucune transaction d'origine n'est fabriquée à partir du calculationId. La même identification de calcul n'est pas assimilée à une opération financière unique : le futur effet réel exige sa propre liaison/outbox/idempotence. Aucun email, transfert ou appel fiscal réel n'est effectué.

Une réservation expirée/changée n'est ni libérée, ni retargetée ou prolongée automatiquement. La fenêtre d'idempotence d'origine de 23 heures ne rend pas fraîche une observation de contexte expirée ; un pending peut requérir une décision humaine. Le CAS final ne garantit pas qu'aucun calcul n'aura été inutile entre deux transactions. Les changements de configuration après promotion ne sont pas encore raccordés.

Limites héritées : promotion et premier append séparés ; interdiction administrative TRUNCATE couvrant aussi certaines tables CH/non promues ; READ COMMITTED US/pays inconnu distinct du cas CH confirmé ; replay/snapshots bornés. PGlite sérialisé, sans preuve multiconnexion, crash recovery, charge de 150 entreprises, SLA ou staging. Les fences Auth/D1/Stripe/PG ne forment pas une transaction distribuée.

## 7. Terminé localement

Nouvelle facture durable et numérotée une fois, paiements partiels et avoir sur le même vrai livre. Source fiscale et preuve TEST corroborées indépendamment en SQL, liaison atomique, reprise sans doublon, historiques et anciens ports protégés. Les huit sources sont enregistrées avant la preuve et cette livraison.

## 8. Encore expérimental et suite

Privé/local/TEST ; aucun consommateur public ou natif V5 livré dans ce lot. Suite concrète : protocole `financial-pilot` DTO1 whitelist, head léger toutes trois secondes, listes/détails liés à la révision, rapports/exports sur vrai ledger et interface dédiée. Ne pas réutiliser les anciens workbench/exports qui ignorent les crédits ou le header compact. Les rôles privés restent owner/admin/accountant, sans faux rôle pour un lecteur.

Restent également configuration/profils courants, autres commandes et sidecars, Support/Automation promus, comptabilité cash basis et workflows commerciaux complémentaires, sandbox réel/outbox après validation, adoption hébergée, monitoring/charge et examen professionnel des règles réglementaires. L'objectif ERP US complet n'est pas déclaré terminé.
