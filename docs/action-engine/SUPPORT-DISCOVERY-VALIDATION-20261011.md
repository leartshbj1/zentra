# A12 — découverte Support et reprise de préparation privées

Le moteur retrouve désormais le travail depuis les tickets Support persistés et récupère une proposition déjà préparée avant de charger le contexte courant ou la clé fournisseur. Ce raccord est **codé et testé localement, non activé** : aucun endpoint, IPC, scheduler, déclencheur Support ou notification ne l'appelle. L'objectif Action Engine reste en cours.

Source serveur : `13abea85ebe9fcc3454c70cd352ef78993fbb752`. Checkout natif inchangé à `1954f1d4d42d4439b2cb16727515a60b708d2199`, sources A11 `ba69873c54ac24c4f87ece4505a32fe9541208b1`. Manifeste : `docs/evidence/action-engine-support-discovery-20261011.json`, SHA-256 `a08e643a8da9a960541bb6d0c49494b8c44745c19c77f9d820dae7cb15b905bf`. Les commits source précèdent cette documentation.

## Problèmes corrigés

1. **Proposition sauvegardée, réponse perdue.** La préparation exigeait encore le catalogue et la publication courants avant de retrouver son résultat. `readPreparedDeviceQuote` lit d'abord la proposition immuable sous compte, appareil, délégation et pays actuels, puis recontrôle ces droits après les attentes de lecture/empreinte. Une erreur de lecture n'est jamais une absence autorisant une nouvelle préparation. A8 reste obligatoire avant tout nouveau brouillon.
2. **Résultat d'analyse fini, proposition non sauvegardée.** La clé était résolue trop tôt. Le port fournisseur la résout maintenant seulement si le moteur a réellement besoin d'une décision neuve après `intake.start`. Un résultat durable fini peut rejoindre le registre sans nouvelle clé ni appel modèle. Un démarrage déjà incertain n'est pas réattribué.
3. **Changement pendant une analyse.** Le garde pays natif est désormais inclus dans les fences partagés de lecture/progression. Support doit rester en mode `automatic` ou `review` pour terminer une préparation fraîche. Pause, révocation ou nouvelle intention US pendant l'attente du fournisseur refusent la persistance ; l'historique autorisé reste distinct.
4. **Ticket classé sans workflow.** Dans `lib/support/service.ts:1389–1422`, la classification est persistée avant le callback facultatif. Une panne entre les deux peut laisser un ticket final sans workflow. La nouvelle découverte lit directement tickets/intakes/propositions ; elle ne dépend pas de ce callback. Elle reste privée et ne déclenche pas encore le traitement.
5. **Curseurs et droits entre deux lectures.** Les curseurs utilisent UTF-8 strict et base64url canonique, y compris pour les identités authentifiées Unicode. La même page bornée est relue avant retour ; remplacer le lien vers un espace par un autre, fermer un ticket ou changer son admissibilité donne un refus/conflit, sans retourner la page ancienne.

La revue finale des frontières n'a pas identifié d'autre défaut bloquant concret. Cela ne remplace ni la compilation native ni les essais hébergés.

## Contrat de découverte

Entrée privée : `discoverDeviceSupportQuoteWork(request, {limit?, cursor?})`. Sortie : `{sourceIds, nextCursor}`, sans mail, plan, prix ou ID métier. Session appareil réelle, droits payés et délégation actuelle ; un worker Support ne peut pas fabriquer cette identité.

- Page de 20 par défaut, 50 maximum, avec une ligne d'avance ; curseur de 4 096 caractères maximum lié à l'entreprise, au membre et à l'installation. C'est un sélecteur, pas une permission signée.
- Ordre stable `(created_at, id COLLATE BINARY)`. Les IDs source sont les `actionIdentifier` ASCII existants ; les identités authentifiées ne sont pas limitées à ASCII.
- Nouvelle préparation : connecteur actif, Support `automatic`/`review`, classement final `quote`, source ouverte/complète/non ambiguë, admission et pilote actuels. `quote` est un présélecteur, pas une preuve de demande plutôt que d'offre.
- Intake absent, fini ou `preparing` expiré avant démarrage : découvrable. Intake `started` ou `uncertain` : aucun redispatch automatique.
- Proposition existante : découvrable sous lecture historique même après modification du mail, désactivation du connecteur ou pause de progression. Cela ne donne aucun droit de création.
- Exclusion du travail seulement après reçu confirmé, événement immuable, preuve canonique, liaison de réservation et publications exactes corroborés ensemble. Un ACK transport ou reçu legacy isolé ne suffit pas.
- Deux batches de trois SELECT pour une page réussie. Aucune mutation, acquittement ou analyse fournisseur dans la découverte. Les erreurs restent bornées et ne deviennent pas une liste vide.

**Ordre obligatoire pour le futur consommateur : reprendre d'abord l'outbox A11, puis parcourir la découverte.** Un ACK local perdu après confirmation canonique reste un travail local, même si la proposition n'apparaît plus dans la liste serveur. Chaque nouvelle ronde doit repartir sans curseur : un classement tardif ou une expiration de bail peut rendre un ancien ticket admissible sans modifier sa date de création.

## Fichiers

Créés :

- `lib/action-engine/device-proposal-recovery.ts`
- `lib/action-engine/device-work-discovery.ts`
- `lib/action-engine/device-work-discovery.test.ts`
- `lib/action-engine/device-preparation.integration.test.ts`
- `drizzle/0105_action_engine_support_work_index.sql`

Modifiés :

- `db/support-schema.ts`
- `lib/action-engine/device-preparation.ts` et `device-preparation.test.ts`
- `lib/action-engine/device-reservation.ts` et `device-reservation-budget.test.ts`
- `lib/action-engine/published-fences.ts` et `published-fences.test.ts`
- `lib/action-engine/support-source.ts` et `support-source.test.ts`
- `lib/action-engine/confirmation-records.test.ts`
- `lib/action-engine/quote-publication-evidence.test.ts`
- `lib/action-engine/reservation-state.test.ts`

Aucune dépendance, route publique ou source native modifiée. Rapport, manifeste, STATUS, README et plan d'intégration sont enregistrés séparément du code.

## Tests exécutés

| Périmètre | Résultat final |
| --- | --- |
| Action Engine, 42 fichiers | 1 542/1 542 |
| Automation, Support et collaboration, 19 autres fichiers | 524/524 |
| Total distinct | **2 066/2 066**, aucun échec ou ignoré |
| Ciblés A12/A8, 7 fichiers | 199/199, inclus dans le total |
| Registre isolé après échec initial de fixture | 63/63, inclus dans le total |
| `tsc --noEmit --incremental false` | Réussi |
| Lint et format des 15 fichiers TypeScript du noyau touchés | Réussis |
| Build de production, contrôle des assets inclus | Réussi, non déployé |
| `git diff --check` | Réussi |
| Rust, application native et archive réelle | **Non exécutés** |

**84 cas distincts nouveaux** : 68 découverte, huit compositions de préparation D1/workerd, quatre reprises/préparations unitaires, trois gardes pays et une pause Support. Les cohortes de régression sont disjointes ; les passages ciblés et isolés ne sont pas ajoutés deux fois. `ZENTRA_NATIVE_SOURCE_ROOT` et `PGLITE_MODULE_DIR` étaient définies ; les fixtures canoniques ne sont pas sautées.

La découverte exécute le vrai authentificateur appareil et les SQL d'admission/délégation sur SQLite avec la chaîne complète des migrations D1, des comptes et paiements synthétiques et une horloge SQL de test explicite. Les huit compositions de préparation exécutent réellement D1/workerd, intake, registre, moteur et fences ; le contexte/archive et le fournisseur sont synthétiques. Elles couvrent notamment les ACK perdus après sauvegarde et après résultat fini, l'avancement de tête, le connecteur désactivé, la clé absente et la révocation après lecture. Aucun modèle en ligne n'est appelé.

EXPLAIN local vérifie l'index `support_ticket_work_discovery` avec plage `created_at>?`, sans `SCAN t`. Les vrais prédicats restent dans les bornes de 64 paramètres et 16 000 caractères SQL. A8 conserve son cas maximal de 63 paramètres plus le paramètre d'assertion, soit 64, après suppression du garde pays doublonné dans sa fixture.

Les premiers passages sont conservés dans le manifeste : trois échecs ciblés venaient de cette duplication ancienne dans la fixture de budget ; trois échecs de régression supposaient que 0104 resterait la dernière migration. Les assertions exigent maintenant la présence exacte de 0104 dans la chaîne cumulative. Un quatrième échec de régression concernait `beforeEach` d'une fixture du registre ; la cause exacte n'est pas prouvée. Les 63 cas isolés puis la régression complète à quatre workers passent, sans changer le code du registre, sa fixture ou ses timeouts. Le build conserve ses avertissements de conventions middleware, classification de routes et temps de plugins.

## Migration et retour arrière

`0105_action_engine_support_work_index.sql` ajoute uniquement l'index `(workspace_id, created_at, id)` ; le schéma Drizzle le reflète. Chaîne cumulative testée sur bases éphémères. Aucun enregistrement, permission, consentement ou état de workflow changé. Aucune migration Supabase/natif ajoutée, ancienne migration réécrite ou migration distante appliquée.

Retour arrière de ce lot : retirer ses raccords privés et, si nécessaire, supprimer uniquement le nouvel index après retour au code antérieur. Aucune restauration ou suppression de données métier n'est requise. Les exigences permanentes de coordination A4 pour une entreprise ultérieurement protégée restent applicables.

## Risques et limites restantes

- **Natif non validé.** Les 136 tests Rust restent écrits mais non compilés/non exécutés. Windows App Control 4551 n'a été ni retenté ni contourné ; aucun exécutable natif, émulateur ou build natif lancé. Version 1.90.15 et schémas62 inchangés.
- **Pas de preuve hébergée.** Aucun login Stripe/Supabase, publication PG/Storage, vraie archive Rust, synchronisation multiappareil ou déclencheur→brouillon→notification en ligne n'est prouvé par ces tests locaux.
- **Expéditeur de connecteur API.** `service.ts:1557–1567` ne conserve pas encore d'expéditeur structuré. Un tel ticket peut être découvert mais reste non planifiable : l'e-mail manquant impose une revue, jamais une identité inventée depuis le corps.
- **Révision globale.** Une publication Gestion sans rapport peut périmer une proposition non réservée. Aucun rebase automatique de son plan immuable ; la revue reste conservatrice.
- **Clé indisponible après démarrage.** Une nouvelle préparation qui échoue après `start` reste incertaine et ne rappelle pas automatiquement l'IA. Configurer la clé validée avant le futur pilote.
- **Charge non mesurée.** Index et sortie bornée ne garantissent pas un scan/CPU strictement borné sur une file clairsemée, ni 150 entreprises simultanées. Aucun benchmark hébergé n'a été effectué.

## Terminé et restant

**Terminé localement** : reprise historique avant contexte/clé, fournisseur paresseux après start durable, fences pays/pause, découverte persistée authentifiée et paginée, index additif, tests et preuves.

**Encore expérimental/inactif** : orchestration native et exposition du parcours. Avant activation : compiler et exécuter les 136 tests natifs et régressions sur un hôte autorisé ; vérifier une vraie archive synthétique Rust ; valider le gateway et PostgreSQL multi-connexions en staging approuvé ; exposer le contrat fermé à sélecteurs, reprendre l'outbox avant les rondes de découverte, superviser les analyses incertaines et notifier seulement après confirmation canonique. Émission, e-mail, paiement et comptabilisation restent hors du moteur de brouillons.

Aucun déploiement, appel fournisseur, e-mail réel, paiement ou donnée client n'a été utilisé ou modifié.
