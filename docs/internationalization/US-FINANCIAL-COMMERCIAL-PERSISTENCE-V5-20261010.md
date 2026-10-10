# Zentra US — plan de continuité commerciale PostgreSQL TEST V5

Actualisation après exécution : le sous-ensemble prévu est implémenté et validé localement ; voir `US-FINANCIAL-TEST-COMMERCIAL-V5-20261010.md` et `docs/evidence/us-financial-commercial-v5-20261010.json` pour les fichiers et résultats réels (4 875 tests / 146 fichiers). Le texte ci-dessous conserve le plan antérieur ; sa matrice proposée n'est pas une affirmation que chaque variante a été exécutée. Les limites production/public/ERP complet restent ouvertes.

10 octobre 2026. **Plan, pas livraison exécutée.** Ce document prépare le prochain jalon après la fondation et les avoirs/encaissements PostgreSQL TEST. Il n'active aucune route, interface, migration hébergée ou capacité publique ERP5. Les résultats de validation de ce futur jalon restent à produire sur ses sources finales.

## 1. Modifications proposées et contrat précis

### Résultat métier borné

Après promotion et après un avoir, une entreprise TEST pourra créer ou modifier un client, créer ou modifier un devis, accepter ce devis, puis continuer les avoirs et encaissements sur ses factures historiques. Tous ces changements auront une seule révision de livre, un seul historique de reçus et une seule comptabilité dérivée. Un redémarrage local devra retrouver cet état exact.

La capacité distincte sera **`postgres-test-commercial-v5`**. Liste fermée d'opérations :

| Opération | Effet admis |
| --- | --- |
| `erp_command` / `save_customer` | Un client créé ou remplacé ; aucun effet comptable. |
| `erp_command` / `save_estimate` | Un devis créé ou remplacé à la révision attendue ; aucun effet comptable. |
| `erp_command` / `accept_estimate` | Un devis accepté à la révision attendue ; aucun effet comptable. |
| `customer_credit` | Avoir sur une facture historique admissible, selon la politique et le plan fiscal TEST existants. |
| `customer_payment` | Encaissement sur une facture historique, dans la limite du dû après crédits. |

Restent refusés : fournisseur, projet, nouvelle facture, paiement via la commande legacy `record_payment`, achat, journal manuel, contrepassation, ouverture/fermeture de période, changement de configuration et promotion via ce port. Une éventuelle référence à un projet dans un devis doit désigner un projet **déjà présent dans la baseline**, actif et appartenant au même client ; ce jalon ne crée ni ne modifie de projet.

Le premier lot conserve les grants TEST existants `owner`, `admin`, `accountant`. `member` et `read_only` ne sont pas ouverts implicitement. Une future admission commerciale de `member` devra classifier l'opération canonique et préserver les refus financiers ; elle n'est pas obtenue en élargissant simplement la liste des rôles du grant financier.

### Trois RPC nouveaux

Toutes les fonctions sont `VOLATILE`, `SECURITY INVOKER`, `SET search_path = ''`. Signatures proposées, à conserver identiques entre migration, adaptateur et tests :

```sql
public.zentra_read_us_financial_commercial_test_v5(
  p_organization text,
  p_actor jsonb,
  p_grant_version bigint,
  p_capability text
) returns jsonb;

public.zentra_us_financial_commercial_test_receipt_v5(
  p_organization text,
  p_actor jsonb,
  p_grant_version bigint,
  p_capability text,
  p_idempotency_key text
) returns jsonb;

public.zentra_append_us_financial_commercial_test_v5(
  p_organization text,
  p_actor jsonb,
  p_grant_version bigint,
  p_capability text,
  p_expected_revision bigint,
  p_previous_fingerprint text,
  p_book jsonb,
  p_receipt jsonb
) returns jsonb;
```

`p_capability` doit être exactement `postgres-test-commercial-v5`. Ce nom est une sélection de contrat serveur, pas une preuve d'authentification ni un droit accordé par le client.

- **Read** : `null` seulement en l'absence de promotion ; sinon le `UsFinancialBookV5` privé canonique complet, reconstruit depuis la baseline et les événements. Aucun `ErpState` v4 de compatibilité n'est retourné comme état courant.
- **Receipt** : `null` si la clé n'existe pas ; sinon `{ origin, actorId, receipt }`. `origin` conserve les valeurs existantes `legacy_erp4`, `promotion`, `financial_v5`. Les événements commerciaux utilisent l'index commun `financial_v5`, dont le reçu externe porte `action: "erp_command"`. Une clé legacy/de promotion reste réservée, jamais interprétée comme un succès commercial.
- **Append** : le `UsFinancialReceiptV5` exact retenu, aussi lors d'une reprise exacte historique ; aucune réponse de succès avant validation des contraintes différées de transaction. `p_book` et `p_receipt` sont des candidats privés : PostgreSQL doit les reconstruire et les comparer, et non leur faire confiance parce que leur hash est cohérent.

Le port TypeScript propose le même `read(organizationId)`, `receipt(organizationId, key)`, `commit(UsFinancialCommitV5)` que le runtime privé, avec cette capacité distincte. Il n'ajoute ni `supportedSchemaVersion: 5`, ni méthode de promotion, ni fallback vers ERP4 ou le store mémoire.

### Identité canonique des commandes et événements

La requête privée commerciale conserve le contrat existant :

```ts
{
  idempotencyKey: string,
  expectedRevision: number,
  command: {
    type: 'erp_command',
    request:
      | { type: 'save_customer', customer: Contact }
      | { type: 'save_estimate', id: string, expectedEstimateRevision: number,
          customerId: string, projectId?: string, date: string, expiresAt: string,
          paymentTermsDays: number, lines: readonly SalesLine[], notes: string }
      | { type: 'accept_estimate', estimateId: string, expectedEstimateRevision: number }
  }
}
```

`Contact` et `SalesLine` doivent satisfaire leurs validateurs existants avec des clés exactes et une organisation liée au livre ; ce document ne crée pas un second format de contact ou de ligne. La requête ne contient ni taxProof, grant, rôle, montant calculé, header, écriture ou effet comptable.

Un événement commercial reprend exactement le contrat `UsFinancialErpEventV5` du moteur mémoire : `{ revision, id, operation, actor, commit, effects }`, avec `operation = { type: "erp_command", idempotencyKey, command, facts: { kind: "none" } }`. `commit` est l'effet ERP4 privé de compatibilité **reconstruit**, pas une deuxième transaction ni un second registre durable. `effects` doit être exactement `{ postings: [], audit: [] }` dans ce lot. Aucun fait d'émission de facture n'est admis.

L'identité du reçu externe est :

```text
commandHash = SHA256(canonicalJSON([
  organizationId,
  actor.userId,
  { idempotencyKey, expectedRevision,
    command: { type: "erp_command", request: operation.command } }
]))
```

Le reçu est exactement `{ idempotencyKey, commandHash, revision, entityId, action: "erp_command", actorId }`. Son `entityId` est `customer.id`, `command.id` pour le devis, ou `estimateId` pour l'acceptation. Le reçu ERP4 interne à `event.commit` conserve sa propre action `save_customer` / `save_estimate` / `accept_estimate` et son hash de requête ERP4 ; il ne doit pas être confondu avec le reçu externe V5.

### Projecteur et reconstruction du préfixe

Créer des helpers JSON purs, distincts des assertions couplées aux tables legacy. Le schéma conceptuel proposé est `zentra_us_commercial_project(book)`, `zentra_us_commercial_transition(prefix, operation, actor, id)` et `zentra_us_commercial_replay(book)`. Les noms internes peuvent être adaptés ; leur séparation de responsabilité est obligatoire.

1. Démarrer sur la baseline ERP4 validée, immuable, et la promotion existante. Révision de livre initiale = `baseline.revision + 1`.
2. Rejouer chaque événement dans l'ordre. Reconstruire son corps exact depuis **le préfixe déjà validé**, comparer au corps durable, puis seulement mettre à jour la projection JSON en mémoire SQL.
3. Dériver ensemble configuration, compteurs, clients, devis, factures historiques avec paiements, fournisseurs/achats/projets historiques, crédits, règlements et ledger réel. Aucun de ces registres courants n'est écrit dans les tables ERP4 ou dans une nouvelle table d'état mutable.
4. Pour `save_customer`, remplacer/ajouter uniquement ce client. Conserver byte-for-byte les snapshots client des devis et factures préexistants, les lignes, les montants et les paiements.
5. Pour `save_estimate`, chercher le client et l'éventuel projet dans la projection courante ; contrôler la révision de devis attendue et l'absence de conversion en facture. Conserver le numéro d'un devis existant, incrémenter le compteur `estimate` une fois pour une création, incrémenter la révision du devis une fois, recalculer les totaux/arrondis à partir des lignes et produire le snapshot client courant. Le document résultant est `draft`, sans clés de commande parasites.
6. Pour `accept_estimate`, chercher le devis courant, contrôler sa révision et son absence de conversion, conserver tout le reste du snapshot, changer le statut en `accepted` et incrémenter la révision exactement comme le moteur existant. Aucun calcul fiscal ni effet financier.
7. Pour crédit/encaissement, conserver les règles settlement existantes et leurs plans privés ; prendre les faits nécessaires dans la projection reconstruite. Les factures émises restent historiques ; seul leur historique réel de paiements est enrichi par les événements de paiement.
8. Révision du livre = `baseline.revision + 1 + nombre_total_evenements`. Révision du ledger = `baseline.ledger.revision + nombre_total_audits_reels_ajoutes`. Dans ce lot, chaque crédit/paiement ajoute un audit ; chaque événement commercial en ajoute **zéro**. Ne plus utiliser `baseline.ledger.revision + events.length` dans un helper qui peut recevoir une queue mixte.
9. Reconstruire le `event.commit.header` privé comme le fait le moteur mémoire : ledger de compatibilité sans les écritures d'avoir, audit comprimé/renuméroté, configuration/compteurs courants, révision de livre courante. Cette projection temporaire n'est ni retournée par le RPC comme registre ERP4, ni enregistrée dans un head legacy. Les effets réels restent sur le ledger V5 unique.

Les helpers réutilisables sont les validateurs JSON/texte/date, canonicalisation, entiers mineurs et arrondis existants. En particulier, `zentra_us_purchase_vendor` est un validateur pur du même contrat Contact client/fournisseur ; les helpers d'adresse/date/timestamp, `zentra_us_tax_object`, strings/text/revision et `zentra_us_erp_line_totals` sont également réutilisables après vérification de parité. Il n'existe pas de validateur SQL pur complet de devis à appeler : le nouveau helper doit le reconstruire depuis la commande et le snapshot courant. `zentra_commit_us_erp`, `zentra_us_erp_v4_assert`, les assertions achats/projets et leurs triggers ne sont pas réutilisables comme moteur courant : ils lisent/écrivent `zentra_us_erp_records`, heads et audits gelés. Aucune table temporaire de substitution, désactivation de trigger, GUC de bypass ou fonction legacy renommée non gardée.

### Source de commande commerciale : admission présente, replay historique

La règle existante `zentra_guard_us_sales_order_source` doit être conservée pour les nouvelles mutations : si un `save_estimate` ou `accept_estimate` change effectivement le payload d'un devis référencé par une commande du même espace dont l'état n'est pas `cancelled`, refuser **PO008**, sans événement, reçu, compteur ou curseur ajouté. Un `save_customer` ne réécrit pas implicitement le devis historique et ne déclenche donc pas ce verrou.

Cette vérification de sidecar est **vivante uniquement au nouvel append** et au trigger d'INSERT direct du nouvel événement. Elle n'est pas exécutée par le replay pur, la lecture d'un ancien événement, la corroboration d'un reçu ou la reprise exacte. Une commande créée ou changée après l'événement historique ne doit jamais rendre cet ancien événement illisible ou son reçu irrésoluble.

Le lock exclusif de `zentra_workspaces` pour l'organisation est pris avant toute lecture du sidecar et avant les verrous du curseur. Les écritures sidecar existantes prennent ce même lock via leur admission ; elles restent gelées après promotion. Le futur raccord de ces sidecars doit conserver cet ordre. Ne pas lire les commandes d'une autre organisation et ne pas déduire une autorisation d'une absence visible hors verrou.

### Append, reprise, erreurs et capture

Ordre prévu dans une transaction READ COMMITTED :

1. Admettre la capacité exacte ; verrouiller workspace → configuration pays → head legacy existant → grant TEST vivant → curseur financier, sans inversion de l'ordre actuel. Vérifier US/USD/accrual, politique/version de grant, rôle, droit Gestion et horloge acteur TEST (plafond PostgreSQL + 30 secondes ; aucune règle ajoutée sur la date comptable).
2. Reconstruire et vérifier le livre existant, ses plans fiscaux et son curseur/hash. Toute erreur doit rester une erreur privée normalisée, sans payload ou secret dans le message.
3. Vérifier le budget et la forme exacte du candidat ; retrouver une clé existante **avant** d'imposer le CAS courant ou la garde de source vivante. Une reprise exige le même acteur historique, la même commande/hash, révision attendue, empreinte précédente et le préfixe canonique d'origine ; elle conserve l'admission/grant vivants d'aujourd'hui. Un reçu existant ne permet pas un replay sous un rôle désormais refusé.
4. Pour une nouvelle clé, comparer révision et SHA256 du préfixe courant, baseline/politique/promotion immuables, un seul événement ajouté et une seule révision supplémentaire. Reconstruire cet événement indépendamment. Exécuter ensuite la garde de source sidecar présente si applicable.
5. Insérer événement et reçu dans les tables communes, avancer le curseur/hash par CAS. Les triggers d'INSERT direct doivent assurer les mêmes invariants. Les contraintes différées exigent l'ensemble complet événement/reçu/curseur/plan ; toute erreur annule la transaction entière.

Conserver les codes settlement PF001–PF016 et leur mapping documenté. PO008 signifie précisément une source de devis verrouillée par une commande active, pas une indisponibilité réseau. Les commandes hors liste sont refusées avant tout RPC/provider côté runtime et indépendamment en SQL. Aucun appel fiscal, bancaire ou email externe n'est déclenché par ce lot.

Côté adaptateur : capture détachée/frozen des inputs avant le premier `await`, clés exactes, corroboration des reçus avec l'événement canonique, fresh pre/post après toute attente ou hash, revalidation finale même si le résultat est malformé. Horloge de confiance monotone ≥ acteur exécuté ; retry historique autorisé lorsque l'horloge courante a avancé. Un postflight refusé après un append éventuellement réalisé ne doit jamais être présenté comme preuve d'absence de commit ; le protocole conserve la clé et permet une résolution exacte.

### Budgets et absence de deuxième autorité

Conserver les limites actuelles, sans les augmenter silencieusement : au plus 1 000 événements et 1 000 éléments par tableau, profondeur 20, 50 000 nœuds, valeur JSONB sérialisée ≤ 4 194 304 octets, chaîne/clé ≤ 524 288 octets SQL et budget cumulé chaînes+clés ≤ 2 097 152 octets SQL. Les budgets TS comptent des unités UTF16 ; SQL compte des octets UTF8 et peut être plus strict. Tester les limites aux frontières, Unicode et duplication des snapshots dans `event.commit`.

Les entiers financiers restent des chaînes décimales canoniques limitées à 36 chiffres, traitées avec `NUMERIC`/`BigInt`. Les révisions/compteurs restent des entiers sûrs. Pas de `float`, double ou conversion monétaire via `Number`. Rejet atomique avant dépassement, pas de troncature d'historique ou de copie courante destinée à contourner le budget.

## 2. Fichiers à créer

- `lib/international/us-financial-test-commercial.ts` : nouvel adaptateur privé read/receipt/commit et allowlist commerciale exacte.
- `lib/international/us-financial-test-commercial.test.ts` : vrai runtime/moteur, RPC simulé ; autorité, capture, capacité, reçus et erreurs.
- `lib/international/us-financial-test-commercial.postgres.test.ts` : vraie chaîne de migrations/RPC locale, sans prestataire externe, avec NodeFS fermeture/réouverture.
- Une **nouvelle** migration Supabase versionnée de continuité commerciale, créée par l'implémenteur ; ne pas inventer ici un timestamp de migration déjà appliquée.
- Une preuve de recette dans `docs/evidence/`, uniquement une fois les tests réellement exécutés et les sources figées.
- Ce document : seul fichier écrit pour la préparation présente.

## 3. Fichiers existants à modifier lors de l'implémentation

- `lib/international/us-financial-kernel-runtime.ts` : nouvelle capacité admise, allowlist de trois commandes, conservation des refus des autres stores et opérations. Les guards de capacité doivent rester vrais après revalidation.
- `lib/international/us-financial-kernel-erp.ts` et tests : réutiliser le contrat mixte existant ; corriger seulement les écarts de parité prouvés par SQL, sans ouvrir des effets supplémentaires.
- `lib/international/us-financial-test-foundation.ts` : uniquement si un helper de capture partagé doit être réutilisé ; aucune ouverture de promotion/append historique.
- `lib/international/us-financial-test-settlement.ts` et tests : conservation de sa capacité fermée aux événements commerciaux et erreurs d'upgrade explicites, sans fallback.
- Documentation de statut/persistance et livraisons précédentes : indiquer les capacités cumulatives réellement disponibles après la recette, sans réécrire leurs résultats historiques.

Les fichiers de migration déjà versionnés, `ErpSchemaVersion`, transports HTTP/natifs, UI/browser, CH, tarifs et paiements SaaS ne sont pas modifiés par ce plan.

## 4. Migration, RLS et retour arrière proposés

Utiliser les mêmes `zentra_us_financial_test_heads`, events, receipts, cursors, tax_plans et grants. Pas de nouvelle comptabilité courante, de promotion bis ou de reprise destructive des événements settlement existants. La migration doit lire et valider les livres déjà settlement avant d'installer ses nouveaux gardiens ; un livre incompatible provoque son rollback, jamais un nettoyage.

Les remplacements en place des triggers event/receipt/cursor/complete doivent comprendre les deux formes d'événement et classifier le payload canonique. L'ancien port settlement continue de fonctionner pour un livre sans événement commercial ; dès une queue commerciale, il refuse explicitement PF008 avant de présenter une promotion ou une baseline comme état courant. Foundation reste fermée aux queues non vides. Aucune ancienne fonction privée renommée accessible sans garde.

RLS reste activée. Révoquer PUBLIC/anon/authenticated sur tous les nouveaux helpers/RPC ; accès serveur de confiance seulement avec grant vivant. `service_role` ne gagne aucune faculté de provisionner ses grants ou plans fiscaux. Une capacité textuelle, un JSON de rôle ou une proof client ne remplace pas ces contrôles. Ne pas annoncer d'isolation contre un service_role qui possède déjà des accès de lecture privés ; son caractère de serveur de confiance reste documenté.

Rollback opérationnel : désactiver le grant TEST avec version incrémentée, conserver baseline, événements, reçus, curseur, plans et marqueur ; refuser les anciennes capacités incompatibles et corriger par migration additive. Ne jamais retirer le marqueur pour réouvrir ERP4 sur un espace avancé. Aucun rollback SQL descendant ou retour à une ancienne application incapable de lire la queue commerciale n'est considéré sûr sans procédure supplémentaire.

## 5. Matrice de validation à exécuter

**Aucun test du futur jalon n'est exécuté par la rédaction de ce document.** Les suites existantes ne prouvent pas les nouveaux RPC. Critères de recette ciblés :

| Domaine | Scénario et oracle indépendant |
| --- | --- |
| Parcours métier | Baseline facture 107/encaissé 50 → crédit 35 → nouveau client → nouveau devis → acceptation → encaissement 22. Reçu final 72, crédité 35, dû 0. Les mutations commerciales ne changent ni ces soldes ni les journaux historiques. |
| Révisions | Chaque mutation commerciale fait +1 livre et +0 ledger ; crédit/paiement font +1 livre/+1 audit. Prochain paiement après trois mutations utilise la révision ledger réelle, pas le nombre d'événements. |
| Client | Mise à jour répétée du même ID admise ; aucune réécriture des snapshots devis/factures existants, aucune donnée inter-tenant, formes/adresses/Unicode invalides refusées. |
| Devis | Création avec compteur exact, édition conservant le numéro, révision périmée refusée, acceptation exacte, facture source déjà émise verrouillée, projet historique réel/actif/même client requis si présent. |
| Source commande | Nouvelle édition/acceptation changeant un devis lié à une commande active refusée PO008 sans effet ; commande annulée autorise ; autre devis/espace sans impact. Instrumenter la garde vivante pour prouver qu'elle n'est pas appelée par read/replay/reçu/retry historique, même si son résultat présent serait différent. |
| Replay | Clé exacte après événements ultérieurs renvoie le reçu d'origine sans avancer le livre. Actor/hash/commande/fingerprint/préfixe différents refusés. Clés legacy/promotion/crédit/paiement/commercial toutes réservées ensemble. |
| Effets falsifiés | Hash correct avec client substitué, mauvais devis/totaux/numéro, mutation d'une autre collection, `effects` non vide, header/périodes/ledger modifiés, reçu interne/externe confondu : refus SQL par reconstruction. |
| Avoirs/paiements | Reprendre les allocations cumulatives, arrondis, preuve historique zéro vs tranche arrondie zéro, plan privé et solde résiduel settlement. Les nouveaux événements commerciaux ne changent aucune de ces règles. |
| Autorité | Grant désactivé/version changé, rôle changé, mauvais tenant/pays/devise/basis/politique, entitlement absent et acteur futur/horloge inversée : refus. Le retry garde une admission actuelle ; malformed RPC/hash ne masque pas une révocation postflight. |
| Accès direct | INSERT event/receipt incomplet, cursor faux, UPDATE/DELETE/TRUNCATE d'historique, émission de facture ou autre commande hors liste, tableaux/prototypes/getters/JSON malformés : refus. Vérifier ACL via rôles SQL réels et ne pas se limiter au catalogue. |
| CAS/rollback | Deux candidats issus du même préfixe : le second refuse après succès du premier. Chaque faute injectée avant/après event/receipt/cursor annule tout. Transaction promotion distincte de premier append comme aujourd'hui. |
| Compatibilité | Ancien settlement lisible avant queue commerciale, refus explicite ensuite ; foundation/ERP1–4 toujours fermés sur espace promu ; autre espace US et CH inchangés ; aucun write dans records/head/audit legacy. |
| Persistance/budget | Fermeture propre puis réouverture NodeFS restitue livre, reçus, soldes et guards exacts. Limites de budget/revision, 36 chiffres, Unicode et payload profond refusés atomiquement. |

Exécuter ensuite typecheck, lint typé des sources concernées, tests ciblés domaine/adaptateur/PostgreSQL, régression globale du dépôt et build production. Consigner commandes et résultats réels. PGlite démontre la chaîne SQL et le rollback séquentiel ; il ne démontre pas les courses multi-connexions. Prévoir séparément un PostgreSQL à plusieurs connexions pour workspace-lock vs sidecar, deux append concurrents, révocation pendant lock wait et deadlocks ; ne pas présenter ce test comme exécuté s'il ne l'est pas.

## 6. Risques et limites identifiés

- Le replay intégral reste borné ; ce jalon ne démontre ni SLA, ni débit de 150 entreprises, ni journal illimité.
- D1/Auth/Stripe et PostgreSQL ne partagent toujours pas de transaction. Un fresh pre/post et un grant local TEST ne sont pas une révocation de production distribuée atomique.
- La protection source commande doit vivre à l'admission présente, pas dans les fonctions pures de replay. Mélanger les deux rendrait l'historique dépendant d'un sidecar courant.
- Les tables legacy et sidecars restent gelés. Leur présence permet des contraintes de source en lecture ; elle ne signifie pas que ces menus sont raccordés au livre V5.
- Le registre fiscal est toujours une autorisation locale TEST. Aucun reversal observé, remboursement, nouvelle transaction fiscale ou certification US GAAP n'est annoncé.
- Le refus administratif global de TRUNCATE hérité reste une limite d'exploitation, y compris pour des tables CH/non promues protégées. Aucune nouvelle activation hébergée n'est autorisée par ce document.

## 7. Critère de jalon terminé

Le jalon sera terminé seulement lorsque le parcours métier de la matrice s'exécutera contre les vrais nouveaux RPC PostgreSQL, avec reconstruction indépendante, CAS/receipts/guards cohérents, aucune seconde autorité courante, reprise après réouverture propre et régressions requises réellement vertes. Une simple capacité TypeScript ouverte, un JSON accepté par SQL ou une démo mémoire ne remplissent pas ce critère.

À la date de rédaction, seul le **plan** est terminé. L'implémentation, les migrations exécutées localement et leurs résultats ne sont pas revendiqués.

## 8. Expérimental et suite obligatoire

Ce lot reste privé/local/TEST, réservé aux grants explicites et à des données fictives. Il fournit une vraie continuité commerciale limitée, sans prétendre achever l'ERP américain. Les jalons suivants restent fournisseurs/projets/achats, journaux/périodes, puis émission de nouvelle facture avec sources/proofs fiscales fiables et garde PO011, sidecars du même livre, paiements/remboursements/cash basis, outbox/transactions/reversals fiscaux, autorités hébergées, projections/exports, navigateur/appareils et validation professionnelle.

Références internes relues : `US-FINANCIAL-PERSISTENCE-V5-20261010.md`, `US-FINANCIAL-KERNEL-V5-20261010.md`, `US-FINANCIAL-TEST-FOUNDATION-V5-20261010.md`, `US-FINANCIAL-TEST-SETTLEMENT-V5-20261010.md`, contrats/runtime/moteur V5 et migrations ERP4/commandes/foundation/settlement. Ce plan ajoute des décisions d'architecture limitées, aucune nouvelle règle fiscale nationale ou affirmation réglementaire.
