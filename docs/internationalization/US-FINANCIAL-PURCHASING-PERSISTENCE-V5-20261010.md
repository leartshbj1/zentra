# Livre financier US V5 — plan de persistance des achats

10 octobre 2026. **Plan uniquement, pas une livraison.** Ce document prépare le jalon suivant la continuité commerciale PostgreSQL TEST. Il ne modifie ni moteur, ni migration, ni permission, ni configuration hébergée. Aucun test n'a été exécuté pour sa rédaction. Les preuves du lot commercial courant doivent rester dans sa propre livraison ; ce plan est exclu de son commit et ne lui ajoute aucun résultat.

## 1. Modifications proposées et contrats privés

### Résultat métier borné

Permettre, après promotion V5 et sans revenir aux tables ERP4, de créer ou modifier un fournisseur, enregistrer une facture fournisseur approuvée manuellement, puis enregistrer ses paiements partiels ou entiers. Les clients, devis, acceptations, avoirs clients et encaissements déjà admis doivent continuer à fonctionner dans le même livre. La finalité est un cycle fournisseur → dette → règlement durable, pas un nouvel écran de préparation sans effet comptable.

Le domaine existe dans `purchasing.ts`, `accounting/postings.ts` et le pont mémoire `us-financial-kernel-erp.ts`. Il sert de référence de parité ; il ne constitue pas déjà une preuve de reconstruction SQL V5. Les anciennes RPC d'achat ERP4 et leurs assertions lisent les tables legacy gelées : ne pas les réutiliser comme moteur courant.

Périmètre proposé : société US, USD, base **accrual**, environnement **TEST** et données fictives. Les trois nouvelles commandes sont `save_vendor`, `record_vendor_bill`, `record_vendor_payment`. L'allowlist complète du nouveau port est limitée à ces trois commandes, `save_customer`, `save_estimate`, `accept_estimate`, `customer_credit` et `customer_payment`. Aucune autre commande ERP n'est implicitement admise.

Sont exclus : projets nouveaux/modifiés, nouvelle facture client, commandes fournisseurs, avoirs/remboursements fournisseurs, stocks, immobilisations, amortissements, charges constatées d'avance, cash basis, journaux manuels, ouverture/clôture de périodes, virement/ACH/Stripe, archivage ou analyse automatique de justificatifs. Les données historiques de ces registres restent conservées dans la baseline et la projection autorisée, sans nouvelle permission de mutation.

### Capacité et factories fermées

Proposition : `postgres-test-purchasing-v5`, distincte de `postgres-test-commercial-v5`, `postgres-test-settlement-v5`, `postgres-test-foundation-v5` et du runtime mémoire. Elle désigne un port privé de serveur, pas un schéma public, un droit commercial ou une valeur acceptée du navigateur.

Ajouter une factory nommée `createSupabaseUsFinancialPurchasingTestStoreV5`, avec le même contrat de client RPC privé, de scope capturé et de callback de revalidation que les deux factories actuelles. Le helper commun de `us-financial-test-store.ts` reste privé ; pas d'API permettant de fournir arbitrairement noms de RPC, allowlist ou capacité. Le runtime refuse une commande hors périmètre avant tout RPC ou appel externe, puis refait ce contrôle avec l'autorité fraîche. SQL applique indépendamment sa liste fermée.

Permissions finies : grant TEST privé actif et versionné, même organisation, identité réelle inchangée, droit Gestion, rôle `owner`, `admin` ou `accountant`. Pas de permission financière pour `member`/`read_only`, y compris pour `save_vendor` dans ce lot. Un texte de capacité, `managementEntitled: true`, un acteur JSON ou une horloge transmis à une RPC ne constituent pas l'authentification de l'utilisateur. L'admission serveur, le grant protégé et les gardes SQL restent nécessaires.

### RPC proposées

Les paramètres et enveloppes suivent le lot commercial, sans port générique public :

```sql
zentra_read_us_financial_purchasing_test_v5(
  p_organization text, p_actor jsonb,
  p_grant_version bigint, p_capability text
) returns jsonb;

zentra_us_financial_purchasing_test_receipt_v5(
  p_organization text, p_actor jsonb,
  p_grant_version bigint, p_capability text,
  p_idempotency_key text
) returns jsonb;

zentra_append_us_financial_purchasing_test_v5(
  p_organization text, p_actor jsonb,
  p_grant_version bigint, p_capability text,
  p_expected_revision bigint, p_previous_fingerprint text,
  p_book jsonb, p_receipt jsonb
) returns jsonb;
```

Le lecteur renvoie le livre privé complet validé, ou `null` en l'absence de promotion selon le contrat existant. Receipt/append conservent les enveloppes actuelles, la distinction des origines `legacy_erp4`, `promotion_v5`, `financial_v5`, le reçu canonique et les refus de clé réservée. Aucun DTO financier public, route HTTP, projection native ou endpoint de paiement n'est créé par ce lot. Le livre privé, la policy, les grants et les proofs ne doivent pas être exposés tels quels à un futur consommateur.

### Commandes et faits

Les commandes conservent exactement les clés de `erp-request.ts` :

| Commande | Champs après `type` |
| --- | --- |
| `save_vendor` | `vendor` : Contact validé et scoped à l'organisation |
| `record_vendor_bill` | `id`, `vendorId`, `reference`, `date`, `accountingDate`, `dueDate`, `periodId`, `netMinor`, `purchaseTaxMinor`, `expenseAccountId`, `sourceReference` |
| `record_vendor_payment` | `id`, `billId`, `amountMinor`, `paymentDate`, `accountingDate`, `periodId`, `reference` |

L'événement ERP reste `{ revision, id, operation, actor, commit, effects }`. `operation` conserve `{ type: 'erp_command', idempotencyKey, command, facts: { kind: 'none' } }`. Aucun fait d'émission, proof de taxe client, acteur d'approbation ou journal arbitraire n'est ajouté à la commande d'achat. L'acteur réellement admis produit les champs historiques `validatedBy`/`approvedAt` et `recordedBy`/`recordedAt`.

Les révisions de livre et de record sont celles de l'événement V5. `event.id` est le fournisseur, la facture ou le paiement concerné selon le helper existant. Une modification de fournisseur peut réutiliser son identifiant de registre ; ne pas confondre cette règle avec l'unicité d'une nouvelle facture, d'un paiement, d'une clé ou d'une écriture comptable.

### Politique comptable et montants

Le compte de charge reste exclusivement `purchases` (5000), avec les comptes actifs et compatibles `payables` et `cash` déjà définis. `netMinor` et `purchaseTaxMinor` sont des chaînes entières canoniques non négatives, au plus 36 chiffres ; leur somme est strictement positive et soumise à la même borne. `amountMinor` est strictement positif, canonique et ne dépasse pas le solde réel de la facture. Utiliser `NUMERIC`/`BigInt`, jamais `float`, `double` ou une conversion monétaire via `Number`.

Écritures d'engagement attendues :

| Action | Débit | Crédit | Cash flow |
| --- | --- | --- | --- |
| Facture fournisseur | `purchases`, total net + taxe d'achat | `payables`, même total | Aucun mouvement de trésorerie |
| Paiement fournisseur | `payables`, paiement | `cash`, même paiement | `operating`, fixé par le moteur |

La taxe d'achat est incluse dans le coût de ce périmètre manuel ; elle ne crée ni crédit de TVA suisse, ni taxe collectée client, ni droit automatique à déduction fiscale. Aucune détermination de use tax, exemption ou obligation par État n'est annoncée. Cette hypothèse opérationnelle limitée existe déjà dans le moteur ; stocks, investissements et autres traitements nécessitent un autre périmètre et une validation professionnelle. L'interface future doit expliquer qu'il s'agit d'un **paiement enregistré**, sans exécution bancaire.

Conserver exactement les dates civiles valides et distinctes du domaine : facture, échéance, paiement, comptabilisation, période. L'échéance ne précède pas la date de facture. La date comptable doit appartenir à une période ouverte et respecter les clôtures existantes. Ne pas inventer un nouveau lien entre date de paiement et date de facture si le domaine ne l'exige pas ; une évolution de politique doit être explicite et testée, pas cachée dans SQL.

Une facture est unique par organisation, fournisseur, référence exacte et date de facture. Ne pas normaliser silencieusement la référence. Son snapshot fournisseur, ses montants, sa provenance `manual_entry`, son auteur et sa date d'approbation deviennent immuables. Modifier ensuite le fournisseur ne modifie pas la facture. `sourceReference` est une référence déclarée, pas une preuve d'archivage ou d'existence du PDF.

Ne réécrire ni la baseline, ni `policy.version`, ni l'approbation, ni la promotion pour ajouter cette capacité. La policy actuelle demeure `us-accrual-receivable-credit-v1` / `test` ; son nom et sa référence d'approbation ne doivent pas être présentés comme une certification comptable ou une validation professionnelle d'achats réels. Toute activation hors TEST exige une revue explicite des traitements et de l'autorité, pas un renommage silencieux de la policy.

### Reconstruction SQL et grand livre unique

Conserver les tables actuelles `zentra_us_financial_test_heads`, `zentra_us_financial_test_events`, `zentra_us_financial_test_receipts`, `zentra_us_financial_test_cursors`, grants et plans fiscaux. Aucune table de ledger courant, copie ERP4 ou cache doté d'une autorité d'écriture n'est nécessaire.

Point à corriger dans la conception du projecteur : le commercial actuel n'ajoute aucun journal ERP. `zentra_us_commercial_transition` filtre donc les ERP avant une transition settlement ; `zentra_us_commercial_header` compte seulement les paiements clients pour sa révision de ledger compatible. Ces raccourcis sont exacts pour ce lot, **pas après un achat comptabilisé**. Un simple élargissement des allowlists produirait des révisions de journal incorrectes ou omettrait les achats du contexte comptable.

Proposer des helpers purs, par exemple `zentra_us_purchasing_current`, `zentra_us_purchasing_header`, `zentra_us_purchasing_transition`, `zentra_us_purchasing_replay`, puis retargeter le constructeur commun `zentra_us_settlement_book` et les gardiens réellement utilisés vers ce replay complet. Le choix exact des noms peut changer ; le contrat suivant ne doit pas changer :

1. Partir de la baseline4 canonique et du préfixe vide de promotion. Reconstituer les registres courants, compteurs, ledger, périodes, avoirs et paiements à chaque événement, dans l'ordre de révision.
2. Reconstruire chaque événement depuis la commande et le préfixe validé, puis comparer exactement record/commit/effects/acteur. Ne pas considérer les changements ou journaux contenus dans `p_book` comme des faits vérifiés.
3. Pour `save_vendor`, valider Contact avec les helpers purs, remplacer ou ajouter seulement cette fiche ; aucune facture ou écriture historique n'est modifiée. Un no-op doit conserver la sémantique exacte de l'ERP mémoire.
4. Pour une facture, sélectionner le fournisseur courant, valider référence/dates/période/montants/compte et déduplication, construire le record et son snapshot, puis reconstruire journal et audit sur le **ledger réel V5**. Pour un paiement, sélectionner la facture réelle et sommer uniquement ses paiements historiques validés ; construire le record, la dette restante et le journal/audit exacts.
5. Les crédits/encaissements clients suivants doivent utiliser les révisions et collisions du ledger réel, désormais enrichi par les achats. Leurs règles d'allocation, montant reçu/crédité/dû et plans fiscaux restent identiques. Ne pas transmettre un préfixe privé amputé des achats à une formule qui déduit la révision de ledger du nombre d'événements restants.
6. Le commit ERP4 de compatibilité reste **éphémère et privé**. Il enlève seulement les écritures/audits d'avoir client, comme le pont mémoire, puis renumérote sa propre suite. Il conserve les achats et leurs effets. Le journal/audit réel garde ses révisions non comprimées. Comparer les contenus et les effets exacts avec `us-financial-kernel-erp.ts` ; ne jamais retourner cette compatibilité sous le schéma4 comme état courant.
7. La révision globale reste `baseline.revision + 1 + events.length`. La révision réelle de ledger suit le nombre d'actions d'audit, pas le nombre total d'événements. Un enregistrement de fournisseur ou devis ne l'incrémente pas ; une facture/un paiement d'engagement ajoute le journal et l'audit déterministes attendus.
8. Préserver les garde-fous de collision sur les identifiants et clés réellement réservés dans tout le ledger, y compris les avoirs masqués dans la compatibilité. Une clé de journal fournisseur ou paiement ne peut pas écraser une écriture existante.

Les validateurs JSON/texte/adresse/date/timestamp, Contact, canonicalisation, entiers et arrondis purs existants sont réutilisables après vérification de parité. Ne pas appeler `zentra_commit_us_erp`, les assertions de tables ERP4 ou leurs triggers comme raccourci courant. Aucun staging de données dans les tables legacy, GUC de bypass ou désactivation de garde.

### Reçus, source et autorité autour des attentes

Le reçu externe de l'événement ERP est l'action `erp_command`, avec son hash de requête V5 :

```text
SHA256(canonicalJSON([
  organizationId, originalActorId,
  { idempotencyKey, expectedRevision,
    command: { type: 'erp_command', request: exactErpCommand } }
]))
```

Le reçu ERP4 interne à `event.commit` conserve son action et son hash ERP4 distincts. Une égalité entre ces deux hashes n'est ni attendue ni une corroboration. Le lecteur de reçu doit retrouver l'événement canonique et son préfixe, vérifier le binding et refaire l'admission fraîche après les hashes/lectures asynchrones.

Conserver capture détachée avant le premier `await`, JSON own-data strict, snapshots immuables, horloge de confiance monotone et comparaison à l'acteur effectivement exécuté. Un acteur historique est utilisable pour le retry exact si l'autorité actuelle est encore admise ; il n'accorde pas une autorisation historique permanente. Un refus Auth/grant postflight reste prioritaire, même devant un résultat RPC malformé. Après un append éventuellement réalisé, ne pas traduire ce refus en certitude d'absence de commit ; garder l'enveloppe et la clé originales pour résolution autorisée.

Conserver la garde PO008 sur les **nouvelles** modifications/acceptations d'un devis lié à une commande active, sous le verrou workspace commun. Aucun nouveau gardien de source fournisseur n'est inventé. Le replay historique, les lectures et la récupération exacte d'un reçu ne reconsultent pas les sidecars vivants. PO011 et l'émission de facture restent hors lot.

## 2. Fichiers à créer lors de l'implémentation

- `lib/international/us-financial-test-purchasing.ts` : entrée nommée privée, sans export de factory générique.
- `lib/international/us-financial-test-purchasing.test.ts` : contrat/capture/autorité/capacité/reçus du nouvel adaptateur et du runtime.
- `lib/international/us-financial-test-purchasing.postgres.test.ts` : reconstruction SQL, migrations, mixité, gardiens, rôles et durabilité locale.
- Une migration additive créée avec le CLI Supabase au moment de l'implémentation ; aucun timestamp/fichier SQL n'est créé par ce plan.
- Livraison et preuve structurée du nouveau lot, après exécution réelle de sa recette.

Ce document est le seul fichier créé par la préparation présente. Ces chemins futurs sont des propositions, pas des fichiers annoncés comme livrés.

## 3. Fichiers existants à modifier lors de l'implémentation

- `lib/international/us-financial-test-store.ts` : profil purchasing privé constant, nouvelle factory nommée, allowlist complète, validation du livre et corroboration des reçus. Préserver les deux entrées actuelles.
- `lib/international/us-financial-kernel-runtime.ts` : capacité et admission finies, refus early/postflight des commandes hors lot, rôle financier pour ce port SQL.
- Tests de barrières de capacité/runtime et fixtures : prouver que les anciens ports ne deviennent pas capables de la nouvelle queue et que les droits ne s'élargissent pas.
- `docs/internationalization/STATUS-20261009.md` : état réel après validation, sans modifier les constats historiques ni confondre le plan et sa livraison.

Le domaine achats, le pont ERP mémoire et les types V5 devraient rester inchangés si la reconstruction est réellement conforme. Toute correction nécessaire y demande des tests de parité et une justification séparée. Ne pas toucher l'application CH, les contrats ERP publics1–4, leurs migrations historiques, les routes HTTP/UI/native ou les tarifs pour ce jalon privé.

## 4. Migration, ACL et retour arrière proposés

Avant remplacement des helpers communs, verrouiller les espaces/livres existants dans l'ordre déterministe et prévalider **tous** les livres foundation, settlement et commerciaux concernés, leurs préfixes, plans, reçus et curseurs/fingerprints. Inclure un livre ayant déjà crédit, encaissement et événements commerciaux. En cas d'incohérence, annuler intégralement la migration ; aucune réécriture ou réparation implicite de baseline/historique.

Reprendre l'ordre de verrouillage des admissions existantes : workspace avant configuration/head/grant et curseur ; le même verrou workspace sérialise nouvelles opérations et sidecars. Garder le contrat READ COMMITTED et le traitement CH existants, sans nouvel élargissement global des restrictions d'isolation.

Le constructeur commun, gardiens événement/reçu/curseur et contraintes différées doivent tous utiliser la reconstruction la plus récente. Un INSERT direct d'événement sous rôle serveur doit subir les mêmes validations que l'append. Les écritures événement + reçu + curseur + plan fiscal éventuellement requis restent atomiques. Les plans d'ajustement fiscal concernent les avoirs clients, pas la taxe d'achat manuelle. Leur protection et provenance restent inchangées.

Les ports antérieurs restent fermés à ce qu'ils ne comprennent pas : foundation refuse toute queue ; settlement refuse les ERP ; commercial refuse une queue contenant les commandes fournisseurs. Installer leurs refus PF008 **avant** une reconstruction incompatible et couvrir leurs chemins read/receipt/append, sans fenêtre où une baseline figée paraît courante. Les lecteurs ERP1–4 et sidecars gelés restent fermés après promotion. Le nouveau port peut lire les préfixes historiques qu'il comprend ; il n'accorde pas l'inverse.

Nouvelle admission/RPC/helpers : `SECURITY INVOKER`, `search_path=''`, RLS préservée, aucune permission `PUBLIC`/`anon`/`authenticated`. EXECUTE limité au serveur prévu, droits tables minimaux. Ne pas élargir les droits de création/modification de grants ou plans fiscaux à `service_role`. Ce rôle de confiance peut déjà contourner RLS : les policies ne constituent pas à elles seules une frontière entre ses lectures privées. Aucun ancien helper renommé et encore accessible ne doit offrir un bypass.

Conserver les erreurs PF001–PF016, PO008 et leur mapping contrôlé ; ne pas convertir automatiquement un refus définitif en erreur réseau/retry infini. Si une nouvelle erreur est nécessaire, la documenter et la mapper explicitement des deux côtés.

Retour arrière : avant un premier événement fournisseur, fermer la gate/capacité sans changer les données. Après cet événement, conserver les lecteurs/replay purchasing et tous les historiques ; suspendre les nouveaux appends, puis corriger par migration additive. Ne pas repasser au port commercial, supprimer la queue ou retirer la migration pour simuler un rollback. La restriction administrative globale de TRUNCATE des tables protégées est héritée et reste à documenter, pas à desserrer dans ce lot.

## 5. Tests prévus, non exécutés par ce plan

| Axe | Cas indépendants et résultat attendu |
| --- | --- |
| Parcours mixte | Crédit existant → fournisseur → facture → paiement partiel → édition client/devis/acceptation → encaissement client → dernier paiement fournisseur → second crédit. Tous registres, reçus, journaux et révisions restent cohérents après relecture. |
| Oracle comptable | Facture net10000/taxe825 = dette10825 ; paiement4000 puis6825 = dette0. Débit purchases10825/crédit payables10825, puis débit payables/crédit cash10825 ; aucun crédit de TVA ni mouvement cash au stade facture. |
| Révisions réelles | Alterner no-op fournisseur, devis, crédit, facture fournisseur, encaissement et paiement fournisseur. Distinguer global revision, ledger revision réel et ledger de compatibilité ; conserver les avoirs dans le vrai ledger. |
| Fournisseur historique | Modifier nom/adresse après facture ; nouveau Contact visible, ancien snapshot inchangé. Refuser substitution de fournisseur/organisation, record orphelin et modification de facture validée. |
| Duplication | Référence exacte/date/fournisseur identiques refusés ; références distinctes selon les règles existantes, sans normalisation secrète. Vérifier collisions de clés héritées, commerciaux, financiers, vendor-bill/vendor-payment et IDs d'écritures. |
| Argent | Zéro/négatif/non canonique/decimal/exposant/float, chaîne>36 chiffres, net+tax débordant, paiement nul/excessif, total falsifié et autre devise refusés atomiquement. Cas net0/taxe positive selon le domaine, sans inventer une taxe. |
| Périodes/dates | Date civile inexistante, échéance antérieure, période étrangère/fermée/hors date et clôture antérieure refusées. Dates de paiement et comptabilisation distinctes conformes au domaine. Aucune commande d'ouverture/clôture admise. |
| Effets falsifiés | Hash cohérent avec mauvais fournisseur, snapshot, charge/compte, montant, cashFlowCategory, période, audit, revision ou journal : rejet par reconstruction SQL, pas seulement équilibre débit/crédit. |
| Compatibilité | Même commande/préfixe/acteur produit exactement l'événement du pont TS ; tester baseline avec achats/paiements/journaux historiques et baseline non vide. Aucune seconde autorité persistée. |
| Reprise | Réponse perdue après append, exact retry après événements ultérieurs, même clé autre acteur/corps/préfixe, reçu ERP interne confondu avec externe. Aucun doublon de dette ou paiement. |
| Autorité | owner/admin/accountant admis sous grant actuel ; member/read_only, entitlement absent, tenant étranger, grant révoqué/version changé et capacité falsifiée refusés avant/post attente. Horloge future/recul, callback malformé et mauvaise réponse RPC ne masquent pas la révocation. |
| Garde PO008 | Nouvelle mutation de devis avec commande active refusée ; annulation ultérieure/sidecar modifié n'invalide pas le replay historique. Instrumenter le gardien vivant pour prouver son absence lors read/receipt/retry exact. |
| Ports antérieurs | Foundation/settlement/commercial et public1–4 refusent le livre hors capacité, read/receipt/append compris. Absence d'appel fiscal, bancaire, email ou Automation pour toute commande hors périmètre. |
| SQL direct/ACL | Rôles réels, accès browser interdits, helpers sans EXECUTE public ; INSERT incomplet/forgé, UPDATE/DELETE/TRUNCATE, curseur faux ou reçu manquant refusés avec rollback. Grants/plans restent non provisionnables par le rôle serveur. |
| Migration | Préfixe settlement et commercial semés avant migration ; prévalidation corrompue fait échouer tout le déploiement local sans changement de fonction/donnée. Installation valide conserve hashes historiques et données CH fictives. |
| Durabilité | NodeFS close/reopen vérifie mêmes livres/reçus/solde, pas seulement serialization JSON. Crash réel et deux connexions PostgreSQL indépendantes restent une recette séparée. |
| Budget | Limites JSON/Unicode, snapshots répétés, tableau/clé/chaîne/graphe/profondeur, limite événements et révisions. Refus complet, aucune troncature ou autorité cache. |

Lors de l'implémentation, exécuter tests domaine/pont/adaptateur/PG ciblés puis régression pertinente, typecheck, lint typé, build et diff-check. Renseigner uniquement les commandes et résultats réellement obtenus. Les tests PGlite/NodeFS ne prouvent ni transactions simultanées indépendantes, ni Supabase/PostgREST/Auth hébergés, ni crash/restore industriel, ni débit pour 150 entreprises.

## 6. Risques identifiés

- Le replay intégral et le header de compatibilité répété consomment mémoire, temps et budget. Conserver les bornes actuelles : 1000 événements/éléments, profondeur20, 50000 nœuds, JSONB≤4194304 octets, chaîne/clé SQL≤524288 octets et cumul chaînes/clés≤2097152 octets. UTF16 TS et UTF8 SQL diffèrent ; aucune garantie de taille commerciale ou SLA.
- Le filtre financier et le header du lot commercial ne s'étendent pas automatiquement aux achats ; c'est le principal risque de faux ledger après un crédit.
- Une migration additive qui remplace un helper commun peut casser les historiques si sa sémantique change. Prévalidation, préfixes avant migration, parité TS/SQL et replay exact sont obligatoires.
- D1/Auth/Stripe et PostgreSQL ne partagent pas une transaction. Fresh pre/post et grants locaux TEST ne prouvent pas une révocation distribuée atomique de production.
- `sourceReference` ne garantit pas un document privé conservé ; originaux/propositions/Automation sont encore gelés après promotion. L'enregistrement manuel ne doit pas être présenté comme import automatique opérationnel.
- La charge purchases/operating n'est pas appropriée à tous les achats réels. Aucun stock, investissement, use tax, crédit de TVA ou traitement fiscal professionnel n'est déduit automatiquement.
- Les lectures privées utilisent des comptes serveur de confiance ; aucune exposition publique du book ou de ses proofs ne doit accompagner ce lot.

## 7. Critères du jalon terminé

Le jalon est terminé lorsque le parcours fournisseur→facture→paiements produit de vraies écritures déterministes et durables dans le livre V5 unique, après des événements commerciaux et financiers existants, avec relecture/reprise/rollback vérifiés. Les anciens ports refusent explicitement les états incompatibles, les historiques CH/ERP4 sont préservés, les preuves couvrent les privilèges et les insertions directes, et les résultats réels sont consignés dans une livraison à huit rubriques.

À cette date, **aucun de ces nouveaux critères n'est annoncé satisfait par le présent document**. La capacité proposée, les RPC et la migration ne sont pas implémentées par cette préparation. Les tests du lot commercial courant ne sont pas des tests purchasing V5.

## 8. Expérimental et suite obligatoire bornée

Le lot prévu reste privé/local/TEST et sans certification US GAAP. Aucune migration de production, activation fiscale réelle, publication UI/ERP5, nouvelle installation Windows/macOS/iOS/Android ou donnée client réelle n'est autorisée par ce document.

Suite technique immédiate : porter journaux manuels/contrepassations et périodes sur la même reconstruction, puis **devis accepté → nouvelle facture client** avec seller/tax preparation/proofs fiables, garde PO011 et stratégie de transaction/outbox fiscale. Ne pas élargir ce jalon achats à ces sujets ni prétendre qu'une facture TEST utilisant un calcul fiscal possède une Tax Transaction réversible.

Après ces capacités comptables et d'émission, livrer un consommateur V5 complet et borné : DTO/projections ne contenant pas les facts privés, rapports et exports distinguant réellement encaissé/crédité/dû et payé/dette fournisseur, transports HTTP/synchronisation et interface pilote. Ce raccord doit être un jalon explicite, pas une prolifération indéfinie de ports TEST sans parcours utilisateur. Les versions privées sont des clôtures transitoires de développement, pas de nouveaux produits Zentra ni une deuxième comptabilité.

Ensuite raccorder les sidecars au même livre : commandes commerciales, originaux/propositions fournisseurs, rapprochement et Automation, avec sources courantes, permissions/quota/consentement, approbation et idempotence. Les recettes hébergées autorisées et multiconnexions, paiements clients distincts des abonnements, cash basis, acomptes/avoirs payés/remboursements, taxes/transactions/reversals réels et validation professionnelle restent nécessaires à l'objectif ERP US complet.

Références internes relues : `STATUS-20261009.md`, `US-PURCHASING-RUNTIME-20261008.md`, `US-FINANCIAL-KERNEL-V5-20261010.md`, `US-FINANCIAL-ERP-COEXISTENCE-V5-20261010.md`, `US-FINANCIAL-PERSISTENCE-V5-20261010.md`, `US-FINANCIAL-TEST-SETTLEMENT-V5-20261010.md`, `US-FINANCIAL-COMMERCIAL-PERSISTENCE-V5-20261010.md`, sources domaine/pont/adaptateur et migrations settlement/commercial. Les références primaires et hypothèses comptables existantes sont conservées ; ce plan n'ajoute aucune règle générale des États américains ni avis de conformité.
