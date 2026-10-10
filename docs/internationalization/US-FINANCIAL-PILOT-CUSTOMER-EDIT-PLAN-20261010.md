# Pilote US — correction d'une fiche client V5

10 octobre 2026. **Plan préalable : implémentation et tests encore à réaliser.** Base : banque code `2792075`, documentation `8096d50`, arbre propre vérifié. Plan établi avant développement à partir du code existant. Les vérifications décrites ci-dessous restent à exécuter.

## Résultat et réutilisation

Ouvrir un client existant dans le pilote privé TEST, corriger ses coordonnées/conditions, revoir les différences puis approuver leur enregistrement sur le même livre V5. Préserver les snapshots client des devis et factures existants. Aucun nouvel historique public, CRM ou moteur financier.

Faits vérifiés : le contrat commercial et son formulaire ne proposent que `create_customer` (`lib/international/us-financial-pilot-commercial.ts:23–27`, `components/account/us-financial-pilot-commercial.tsx:126–128,194–207`). Le vrai `save_customer` remplace déjà par ID et appartient au profil cumulatif invoicing (`lib/international/runtime.ts:133`, `us-financial-kernel-runtime.ts:107–117`). SQL reconstruit remplacement/no-op (`supabase/migrations/20261010085523_international_us_financial_test_commercial_v5.sql:34,82–85,121–124`). Party expose déjà tous les champs. **Aucune migration, dépendance, capacité ou autorité nouvelle prévue.**

Conventions reprises des plans commercial/purchasing du 10 octobre : contrat fermé, admissions vivantes, même append, reprise avant contrôle de source ultérieure, recette groupée et livraison en huit rubriques.

## Inventaire exact

**15 fichiers de code/test : 14 existants modifiés, 1 nouveau.**

| # | Fichier | Changement |
| --- | --- | --- |
| 1 | `lib/international/us-financial-pilot-commercial.ts` | Intention update, mapper, clé et reçu. |
| 2 | `lib/international/us-financial-pilot-commercial.test.ts` | Contrat, compatibilité et collisions. |
| 3 | `lib/international/us-financial-pilot-commercial-projection.ts` | Détail client fermé. |
| 4 | `lib/international/us-financial-pilot-commercial-projection.test.ts` | Détail/scope/F/L et snapshots. |
| 5 | `lib/international/us-financial-pilot-commercial-server.ts` | CUSTOMER et contrôle d'existence hors replay. |
| 6 | `lib/international/us-financial-pilot-commercial-server.test.ts` | HTTP/admission/reprise/fences. |
| 7 | `lib/international/us-financial-pilot-commercial-bindings.test.ts` | Nouvelle délégation CUSTOMER ; gates inchangées. |
| 8 | `app/api/international/workspaces/[organizationId]/financial-pilot/customers/[customerId]/route.ts` | **Nouveau**, GET mince. |
| 9 | `lib/international/us-financial-pilot-commercial.postgres.test.ts` | Recette réelle cumulative update/replay. |
| 10 | `lib/international/browser-us-financial-pilot-commercial-input.ts` | Builder pur de revue/corps capturé. |
| 11 | `lib/international/browser-us-financial-pilot-commercial-input.test.ts` | Captures, différences, nulls et limites. |
| 12 | `lib/international/browser-us-financial-pilot-session.ts` | Lecture/revue possédées, envoi et pending update. |
| 13 | `lib/international/browser-us-financial-pilot-commercial.test.ts` | Intégrations avec vrais handlers/kernel/memoryport. |
| 14 | `lib/international/browser-us-financial-pilot-commercial-copy.ts` | Copie FR/DE/IT/EN. |
| 15 | `components/account/us-financial-pilot-commercial.tsx` | Modifier, formulaire, revue, approbation et purge. |

**Pas de CSS** : réutiliser `.fpc-form`, `.fp-form-grid`, `.fpc-current`, `.fpc-review`, `.fp-actions` et le mobile existant, avec avant/après empilés. Bindings productifs, parent, banque, Party général, store/kernel et SQL restent hors inventaire. Le parent relaie déjà reçus commerciaux et `session.retry()`. Tout besoin supplémentaire impose un amendement avant édition.

Documentation distincte : créer `docs/internationalization/US-FINANCIAL-PILOT-CUSTOMER-EDIT-PLAN-20261010.md`, `docs/internationalization/US-FINANCIAL-PILOT-CUSTOMER-EDIT-20261010.md`, `docs/evidence/us-financial-pilot-customer-edit-20261010.json` ; actualiser `docs/internationalization/STATUS-20261009.md`. **19 fichiers suivis avec ces quatre documents** ; logs/captures/scripts restent ignorés.

## Contrat et protocole

Ajouter à l'enveloppe commerciale actuelle :

```ts
type UsFinancialPilotCommercialUpdateCustomerCommand = Readonly<{
  type: 'update_customer'; customerId: string;
  customer: UsFinancialPilotCommercialCustomer;
}>;
interface UsFinancialPilotCustomerDetailQuery {
  readonly revision: number; readonly customerId: string;
}
interface UsFinancialPilotCustomerDetail extends UsFinancialPilotHead {
  readonly ledgerRevision: number; readonly customer: UsFinancialPilotParty;
}
projectUsFinancialPilotCustomer(book: unknown, query: UsFinancialPilotCustomerDetailQuery): Promise<UsFinancialPilotCustomerDetail>;
validateUsFinancialPilotCustomerDetail(value: unknown, organizationId?: string, revision?: number, customerId?: string): UsFinancialPilotCustomerDetail;
```

- Requête : mêmes consumer/schemaVersion/requestId UUID/expectedRevision=F/command, plafonds commerciaux existants (262144 octets UTF-8). Customer contient exactement kind/name/billingAddress/shippingAddress/email/phone/contactName/paymentTermsDays. Les quatre valeurs facultatives sont explicitement nullables ; `null` efface, omission interdite. Réutiliser les validations contact/adresse US/CH et leurs limites. Capture avant await, gel récursif ; extras/getters/prototypes/symboles et autorités privées refusés.
- Le serveur impose organizationId et préserve customerId (texte canonique, sans contrôle, 1–160 caractères). Pour une nouvelle opération, exiger son existence au F attendu dans le tenant ; absent : `customer_not_found` 404, **jamais upsert**. Un reçu exact déjà durable prime sur ce contrôle vivant ; conserver admission et corroboration native de son historique.
- Clé update : **`pilot:commercial:update_customer:<UUID>`** ; anciennes trois actions : clé `pilot:commercial:<UUID>` et comportements strictement inchangés. Cette séparation interdit le faux replay d'une création produisant le même save_customer (mêmes UUID/ID/F/champs). UUID propre au namespace/intention ; autre corps/F sous la même clé update = conflit. Préfixe vérifié statiquement : 69 caractères ASCII admis par runtime:80 et SQL commercial:62 (regexp, maximum200), receipt SQL invoicing:270 (maximum240). `us-financial-test-store.ts:131–133`, pilote-store:120–128 et wrapper DTO SQL:80–90 transmettent sans allowlist de préfixe. L'acceptation réelle reste à tester.
- Reçu public : mêmes six champs consumer/schemaVersion/organizationId/revision/entityId/action, avec `action:update_customer`, entityId=customerId et revision=F+1 vérifiés contre la requête capturée. Ni clé/hash/acteur/proof ni faux statut replay. **Son F historique n'est jamais adopté comme head/snapshot/floor courant.**
- Nouvelle route GET `/api/international/workspaces/[organizationId]/financial-pilot/customers/[customerId]?revision=F`, handler `CUSTOMER(request, organizationId, customerId)`. Query revision unique, positive et sûre ; aucun cursor/B/historique. DTO exact : quatre champs Head + ledgerRevision + customer. Replay V5 réel, tenant/F/ID corrélés, 0≤L≤F, Party public validé. Même admission, cookies, no-store et revalidation que le détail devis ; fence du head avant publication, sinon409. Aucun R client inventé.

## Revue, session et interface

Dans l'input pur existant, sans import runtime de session : `buildCustomerEditReview({organizationId,requestId,revision,source,customer}):CustomerEditReview`. Retour fermé et gelé : `{organizationId,request,body,before,after,changedFields}` ; request est l'enveloppe update, before/after sont des Party complets au même ID, changedFields compare les huit champs dans un ordre fixe. Valider les corrélations et sérialiser le corps une seule fois.

Session : ajouter `readCustomer(customerId, revision?)`, `reviewCustomerEdit(source, customer)` et `submitCustomerEdit(review, approved)`. Seuls les détails effectivement lus sont possédés en WeakMap (generation/mutation/F). Revue la plus récente possédée, UUID alloué une fois, approbation `===true`, snapshot courant et verrou libre exigés avant POST. Refuser clone/foreign/stale et `commercial(update_customer)` direct avant envoi. PendingKind reste commercial et reprise par `retry()` ; pas de second timer.

Invalider ownership/revue à mutation commune, F supérieur ou purge. Recontrôler generation/mutation/F après await **et notification synchrone**, pour empêcher toute réadoption après stop. B seul externe conserve la saisie ; un write bancaire local invalide la revue par mutation. Le formulaire conserve les champs pendant polling/onglet ; F nouveau impose relecture et nouvelle revue explicites. Toute édition locale invalide synchroniquement le token de revue. Stop/denial/tenant/session/dispose purgent sélection/détail/brouillon/revue/références. Cancel autorisé seulement hors pending.

Pour **update uniquement**, aucun HTTP409/422 sans preuve de phase ne libère pending : conserver UUID/corps/F après réseau/timeout/503 ou DTO de succès invalide. Adapter les deux branches de libération de session:240–242 sans changer les trois actions historiques. Denial purge. Reprise exacte ou pending persistant ; pas de rebase implicite. Un vrai CAS sans reçu peut rester bloqué : Reprendre ou recharger explicitement après avertissement/checkbox de perte RAM, sans promettre l'annulation du commit ni nouvel endpoint.

Flux : Modifier → détail courant → formulaire prérempli → avant/après → une approbation humaine → reçu → lecture courante. No-op visible, approbation UI désactivée ; API/native no-op vérifié séparément. Copie quatre langues : correction pour les prochaines opérations, documents historiques inchangés. Ancien devis actualisé seulement par sauvegarde explicitement revue ; aucune réémission/recalcul fiscal silencieux.

## Critères futurs, rollback et limites

1. Contrat/capture : limites UTF-8, mutations pendant attente, nulls, extras/getters ; sélecteurs champ par champ sans spread de row/head. Anciennes actions/reçus/octets conservés ; create/update mêmes UUID+ID+F/champs sans faux replay ; même clé update avec autre corps/F refusée.
2. Vrais handlers/kernel/SQL : créer/modifier même ID, client hors première page (>25), unknown/foreign sans création, no-op, replay après réponse perdue et opération tierce, révocation pendant attente/isolement/refus natif. Fixture PG avec chaîne actuelle complète, incluant les migrations invoice_dto1 et bank_test_v1 postérieures à son ancienne chaîne32 ; fermeture/réouverture NodeFS.
3. Comparer réellement F+1, L/B/journaux/soldes/numéros inchangés ; snapshots devis/facture et export de facture inchangés ; nouveau devis corrigé, ancien devis uniquement après resave explicite. Livre mixte émission/achats/compta/banque : completion historique et montants courants inchangés.
4. Session et vrais handlers/memoryport : ownership, stale, mutations, réentrance stop, verrou commun, vrai commit suivi de409/422, DTO invalide, retry mêmes octets/UUID/F, reçu historique sans régression ni pending recréé après refresh échoué. Les fautes transport seules utilisent des réponses contrôlées.
5. Sources figées : ciblés, PG sérialisé, régression antérieure conservée (anciens alias de recettes et preuves bancaires préservés), types/lint/marque/build ; recette groupée desktop/mobile320px, quatre langues/deux thèmes, clavier, états essentiels saisie/revue/stale/pending/reprise/reload. Une correction groupée puis confirmation bornée, revue indépendante et livraison en huit rubriques avec empreintes/tentatives conservées.

Aucun résultat futur annoncé ici. Si persistance/no-op/replay nécessite SQL ou fichier supplémentaire, arrêter et amender le plan. PGlite sérialisé/Auth-D1 synthétiques ne prouvent pas hébergement, multiconnexion, charge, crash ou SLA.

Retour arrière : fermer les gates TEST si nécessaire, retirer nouvelle intention/route/UI ; conserver marqueur V5, événements et reçus, toujours exprimés par save_customer compris par le store précédent. Aucun effacement, annulation durable ou repli ERP4.

Hors périmètre : CRM/historique supplémentaire, fusion/suppression client, documents émis, avoir/remboursement/projets/commandes, natif V5, provisioning automatique, provider/Stripe/banque réelle, CH, migration hébergée et production. Recette hébergée/admission distribuée et validation financière professionnelle restent externes à ce jalon. L'objectif ERP US complet demeure actif.
