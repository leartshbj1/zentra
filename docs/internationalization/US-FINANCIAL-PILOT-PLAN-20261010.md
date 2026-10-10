# Zentra US — consommateur pilote du livre financier courant

10 octobre 2026. Plan avant développement. À enregistrer après la livraison de l'émission V5 et ses preuves réellement exécutées. Aucun résultat UI, HTTP, charge ou déploiement annoncé ici.

## 1. Résultat attendu

Rendre le livre V5 utilisable dans une interface pilote dédiée : factures, encaissements, avoirs, écritures, périodes et rapports. Ne pas présenter le header ERP4 compact comme le livre courant. Le protocole reste `financial-pilot` DTO1, distinct d'ERP1–4 et des clients natifs.

Construire un projecteur serveur whitelist à partir d'un livre intégralement validé et de `projectUsFinancialBookV5`. Chaque facture affiche séparément total, reçu, crédité et restant, avec l'égalité exacte `total = reçu + crédité + restant`. Les montants demeurent des chaînes de minor units ; aucun float, provider ID ou preuve fiscale privé dans le navigateur.

Un head ne contient que l'organisation et la révision financière sous admission actuelle. Il ne reconstruit pas le grand livre et ne retourne pas ses soldes toutes les trois secondes. Les vrais rapports et `ledgerRevision` arrivent à la lecture du snapshot validé. Les pages sont bornées à 25 éléments, triées de manière déterministe et attachées à une révision. Une autre révision impose `409 financial_snapshot_changed`, sans mélange silencieux de pages.

## 2. Fichiers proposés

- `us-financial-pilot-contract.ts` : DTO1, requêtes fermées, validateurs, pagination et montants.
- `us-financial-pilot-projection.ts` : listes et détails whitelist, aucune transmission d'objet privé masqué ensuite en CSS.
- `us-financial-pilot-reports.ts` : balance, résultat, bilan, trésorerie, grand livre et état de créances.
- `us-financial-pilot-server.ts` et `us-financial-pilot-bindings.ts` : admission, lectures, commandes explicitement câblées et réponses bornées.
- `browser-us-financial-pilot-session.ts` : session liée à organisation/utilisateur, actualisation silencieuse, brouillons conservés.
- `components/account/us-financial-pilot.tsx` et styles : interface dédiée et traductions FR/DE/IT/EN existantes conservées.
- Routes séparées `financial-pilot/head`, listes/détails, rapports et opérations.
- Tests de contrats/projection/rapports, handlers, session navigateur, recette HTTP→PostgreSQL et essais visuels desktop/mobile.

Pas de fichiers natifs, de modification de prix ou d'élargissement d'`ErpSchemaVersion`.

## 3. Fichiers réutilisés/modifiés

Réutiliser `accounting/reports.ts` sur `view.ledger` réel. Conserver la distinction date de transaction, comptable et paiement, le résultat non clôturé explicite et le refus de trésorerie lorsqu'une classification manque.

L'ancien `export-snapshot.ts` valide ERP1–4 et assimile une diminution de créance à un paiement : ne pas l'utiliser pour les avoirs V5. Prévoir un snapshot d'export pilote propre, avec les quatre montants et les paramètres du rapport, puis réutiliser les renderers/fonts seulement si leurs contrats restent honnêtes.

La page `app/compte/espaces/us/[organizationId]/page.tsx` choisira explicitement le consommateur admis. Pas de fallback sur la baseline ou l'ancien workbench pour un livre promu. Les entreprises non promues conservent leur parcours actuel.

## 4. Migration et autorité proposées

Une migration additive fournit le head léger et, si nécessaire, un RPC de scope privé. Aucune réécriture d'événements ou de migrations anciennes. Le head lit le curseur sous le même ordre de verrous et un grant TEST vivant ; il ne s'agit pas d'un cache d'autorisation.

Le serveur authentifie la session Zentra et vérifie membership, rôle et abonnement US D1. Il lit en privé le grant PostgreSQL exact `(organisation, utilisateur)` avec version/policy, compare les rôles et transmet la version capturée aux RPC. Le navigateur ne fournit jamais actor, grantVersion, policy, contexte marchand ou autorisation fiscale. PostgreSQL vérifie le grant vivant/version dans sa transaction ; Auth/D1 restent des fences pré/post séparés, sans prétendre à une atomicité interbases.

Lecture de configuration privée possible via `getWorkspaceCountry` (SELECT direct service), corroborée avec la baseline actuelle ; ne pas rouvrir les anciens readers vendeur/fiscalité/ERP gelés. Mode browser uniquement pour ce consommateur ; Authorization native refusé tant qu'aucune admission V5 native n'est livrée.

Retour arrière : fermer l'opt-in et révoquer les grants pilotes ; conserver sources, lecteurs compatibles et histoire. Pas de queue supprimée, reset de données ou faux retour ERP4.

## 5. Tests nécessaires

Contrats stricts/absence de champs privés, source inconnue et données corrompues ; pages25, tri stable, révision modifiée entre pages ; montants exacts et crédits distincts ; rapports sur vrai ledger ; rôles/abonnements/isolation ; révocation ou changement de compte pendant lecture, erreur et écriture.

Actualisation head3s uniquement visible/online, sans requêtes concurrentes empilées ni écran de chargement ; réponse obsolète ignorée, changement de compte efface les données, brouillons préservés seulement dans leur espace et utilisateur.

Recette deux navigateurs→HTTP réel→PostgreSQL local : facture nouvelle, paiement partiel, avoir, journal, période suivante et rapports concordants. Toute Auth ou observation fiscale fictive est identifiée. Réponse perdue reprise sans double écriture. Types globaux non incrémentaux, lint typé, régression, build et revue visuelle responsive/modes clair et sombre. Aucun succès annoncé avant exécution.

## 6. Risques et limites

Lectures de pages peuvent encore reconstruire le livre borné ; le head évite ce coût à chaque poll, sans promettre SLA ou charge. Ne pas exposer providerReference, evidenceReference, EIN/faits privés, baseline, promotion, policy, events/commits, clés d'idempotence, hashes ou grants.

L'émission exige encore contexte privé frais et gateway explicitement câblé. Un consommateur ne doit pas inventer tax code, taux ou preuve pour rendre un bouton actif. Les commandes non raccordées restent indisponibles avec une explication courte. Aucun effet réel marchand ou outbox activé sans lot séparé et autorisation appropriée.

## 7. Terminé au moment de ce plan

Architecture du consommateur définie et revue sur les sources existantes. Ce document ne constitue ni une implémentation de DTO/routes/UI, ni un test ou une publication.

## 8. Encore expérimental/après ce lot

Convergence d'autorité hébergée, provisioning/configuration courants, sidecars promus, exports complets, admission native, taxes/transactions/reversals et sandbox réel, staging multiconnexion/charge/crash, revue professionnelle réglementaire. L'objectif ERP US complet reste actif.
