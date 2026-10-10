# Noyau financier US interne TEST — livre v5

Date : 10 octobre 2026. Périmètre : worktree `international-site`. Ce lot fait évoluer la préparation d'avoirs du jalon précédent vers de véritables transitions financières **internes et en mémoire TEST**. Il ne déclare pas un nouveau schéma ERP public, une capacité native, une intégration Stripe active ou une conformité US GAAP. Les résultats réellement exécutés figurent en rubrique 5 ; l'objectif international complet reste actif.

Les constats de départ proviennent de `AUDIT.md`, de `STATUS-20261009.md` et des notes `US-CUSTOMER-CREDIT-{RESEARCH,PLAN,CAPABILITY,DELIVERY}-20261010.md`. Leurs résultats historiques ne sont pas des résultats de cette phase. La recommandation antérieure « préparation sans effet financier » décrivait le socle précédent ; elle n'est pas une redéfinition de l'objectif financier désormais développé.

## 1. Résumé des modifications et politique

Le contrat sépare une baseline `ErpState` v4 validée et immuable d'un livre financier interne `UsFinancialBookV5`. Ce livre conserve la politique versionnée et les événements ordonnés ; le ledger courant, les avoirs et les règlements sont dérivés par replay, plutôt que stockés comme une deuxième autorité. Le numéro interne 5 ne doit jamais être négocié ou envoyé à l'ancien `ErpStore`, aux routes, aux exports, aux snapshots synchronisés ou aux appareils ne prenant en charge que les versions 1–4.

Le moteur reconstruit chaque événement, record et écriture depuis les sources validées et refuse une copie modifiée de ces faits. La promotion conserve son acteur propriétaire, son instant et le SHA-256 exact de la baseline ; ces faits ne peuvent pas être remplacés lors d'un append. Les montants restent des chaînes d'entiers en unités mineures, traitées par `BigInt`. L'allocation cumulative par quantité réutilise le noyau historique : net après remise, taxe historique séparée, arrondi déterministe et reliquat exact jusqu'au dernier centime. Ce calcul arithmétique ne détermine pas à lui seul une permission fiscale.

La politique `us-accrual-receivable-credit-v1`, limitée à `environment: test`, vise les factures US/USD dont le revenu a déjà été entièrement reconnu en engagement par le moteur existant. Son approbation comporte référence, personne et date. **Ces champs techniques ne prouvent pas, à eux seuls, une revue professionnelle effective.** Cette revue et la configuration de confiance restent des préalables à une activation réelle ; aucune approbation ne peut provenir d'un DTO navigateur.

### Effets financiers admis

| Opération | Effet dans le livre interne | Limites |
| --- | --- | --- |
| Avoir sur facture avec créance restante | Réduit les quantités/montants encore créditables des lignes historiques et la créance ; conserve l'original et les paiements antérieurs. | Montant strictement positif, inférieur ou égal au restant dû courant ; facture impayée ou partiellement payée. |
| Encaissement après avoir | Débite le compte de trésorerie et crédite la créance, sur le nouveau restant dû. | Montant positif ; aucun dépassement, revenu reconnu une deuxième fois ou paiement négatif. Il s'agit d'un enregistrement interne, pas d'un prélèvement bancaire. |
| Projection de règlement | Sépare `receivedMinor`, `creditedMinor` et `outstandingMinor`. | Un avoir n'est jamais un encaissement. Un règlement avec crédit reste distinct d'une facture intégralement encaissée. |

Pour une facture dont le revenu est déjà reconnu, la mécanique retenue réduit les ventes reconnues et, lorsqu'elle est admise, la dette fiscale, contre réduction d'Accounts Receivable : débit ventes nettes, débit taxe ajustable, crédit AR du total. Un paiement ultérieur ne fait que débit trésorerie / crédit AR. Cette décision de modèle n'étend pas la reconnaissance immédiate aux prestations différées, acomptes ou autres obligations de performance. Elle réutilise le compte `sales` du plan historique plutôt que de modifier globalement le starter chart, dont l'égalité exacte est vérifiée par le validateur legacy.

La documentation primaire Stripe décrit la réduction d'AR par credit note et distingue la contrepartie de revenu déjà reconnu de celle du revenu différé. C'est un modèle documenté par un fournisseur, pas une règle légale nationale ou une certification du plan Zentra. La Publication 334 traite les retours/allowances comme réductions des ventes pour son périmètre fiscal small business ; elle n'impose pas notre journal pour toutes les entités. [Stripe Revenue Recognition](https://docs.stripe.com/revenue-recognition/methodology/subscriptions-and-invoicing), [IRS Publication 334, édition 2025](https://www.irs.gov/publications/p334).

### Facture partiellement payée

La borne `avoir <= restant dû` est une politique déterministe de réduction de créance. Exemple purement arithmétique : total 108 USD, encaissé 50 USD, avoir 40 USD, nouveau restant 18 USD. Les 50 USD restent des encaissements réels ; aucun remboursement ou crédit utilisable ailleurs n'est créé. Un avoir de 58 USD solde cette créance avec crédit ; au-delà, l'opération est refusée par ce premier noyau.

Stripe Invoicing documente également une réduction du restant dû en premier, avec traitement distinct de la partie excédentaire d'un avoir sur facture partiellement payée. Cette source corrobore la séparation AR/restitution ; elle ne prescrit pas une politique fiscale à l'ensemble des entreprises américaines. [Stripe, paiements partiels et credit notes](https://docs.stripe.com/invoicing/partial-payments).

**Caveat fiscal essentiel :** la borne globale d'AR ne prouve pas que la taxe d'une ligne peut être réduite. Les paiements historiques agrégés ne décrivent pas nécessairement quelles lignes ont été payées ni la taxe effectivement collectée/remise. Ne pas dériver la taxe créditable par simple prorata de ces paiements ; le trusted adapter doit autoriser la ligne, l'allocation, le motif et la juridiction appropriés. Un retour physique ne déclenche aucune écriture de stock/COGS tant que ce mouvement et sa politique ne sont pas modélisés.

### Preuve fiscale de confiance

Le candidat financier conserve l'empreinte de la facture réelle et le SHA-256 de l'allocation historique exacte. Le client ne choisit ni preuve fiscale, montant de taxe, journal, rôle, droit d'abonnement ou approbation. La façade demande la preuve à `resolveTax`, port interne de confiance distinct du DTO.

| Preuve interne | Sens admis | Ce qu'elle ne démontre pas |
| --- | --- | --- |
| `historical_zero_tax` | Les lignes et l'allocation retenues ont une taxe historique nulle et une détermination historique admise par l'adapter ; aucun ajustement fiscal n'est annoncé. | Une absence de configuration, `not_collecting`, un booléen d'exemption client ou le seul montant zéro ne sont pas une preuve suffisante. |
| `test_adjustment_authorization` | Autorise un plan TEST précis, lié à la facture et à l'allocation, au compte fournisseur, à une transaction d'origine et au montant fiscal exact. Le document demeure `adjustment_pending`. | Ce n'est pas un reçu de reversal enregistré, une preuve de remboursement, une validation juridique ou une autorité sandbox réellement consultée. |

Le contrat de preuve n'est pas un adapter fournisseur concret. La forme d'un identifiant `tax_…` et la référence d'un plan ne prouvent pas son existence : le futur adapter doit les vérifier côté serveur, dans le bon compte/mode, et conserver leur provenance. Le noyau admet explicitement des références synthétiques `testtxn_…` pour ses fixtures TEST ; elles ne représentent aucune vente Stripe réelle. Une référence de calcul `taxcalc_…` est refusée et ne doit jamais être présentée comme transaction fiscale d'origine.

Stripe distingue le calcul du montant et la Tax Transaction destinée aux enregistrements/rapports ; le guide custom demande de conserver la transaction d'origine pour les reversals. Les factures TEST historiques fondées uniquement sur un calcul ne possèdent pas implicitement cette transaction. Le guide fournisseur ne décide pas à notre place du moment légal de collecte ou de correction pour chaque État. [Stripe Tax custom](https://docs.stripe.com/tax/payment-intent/custom).

### Autorité et reprise

La façade interne relit configuration, acteur, rôle, abonnement Gestion et politique autour des opérations asynchrones ; le pays, la devise et la méthode d'engagement sont obligatoires. Les rôles financiers admis sont propriétaire, administrateur et comptable, sans droit financier implicite pour un membre commercial. Le reçu lie entreprise, acteur, contenu exact, révision, entité et clé d'idempotence. Une même demande reprise doit retrouver son événement ; une clé réutilisée pour un contenu différent est un conflit.

L'adapter de référence en mémoire contrôle l'empreinte précédente, la baseline/politique/promotion immuables, le préfixe d'événements inchangé et une seule nouvelle révision. Un authorizer TEST synchrone, explicitement fourni, recontrôle l'identité, le rôle et le droit lors du replay et au CAS final. Le CAS et l'écriture livre/reçu sont sans `await` intermédiaire dans le même processus. Ce n'est ni un verrou multiworker ni une transaction interbases. Le futur adapter durable doit vérifier l'autorité réelle dans sa transaction. Un redémarrage perd la mémoire ; restaurer explicitement un livre TEST validé permet de reconstruire ses reçus, mais aucune persistance de production n'est livrée.

## 2. Fichiers créés

Inventaire présent au moment de cette revue ; les modules sont isolés dans `lib/international` sans déplacement massif :

- `lib/international/us-financial-kernel-types.ts` : politique, preuves privées, événements, livre et projection de règlements.
- `lib/international/us-financial-kernel.ts` : promotion de baseline4, moteur pur, empreintes, replay, transitions et projection.
- `lib/international/us-financial-kernel-runtime.ts` : DTO strict, frontière de confiance, relectures d'autorité, reçu/CAS et adapter mémoire.
- `lib/international/us-financial-kernel-capability.test.ts` : refus de la version 5 aux frontières publiées existantes.
- `lib/international/us-financial-kernel-test-fixture.ts` : données financières et preuve de politique entièrement fictives pour les essais.
- `lib/international/us-financial-kernel.test.ts` : tests du moteur et de son replay.
- `lib/international/us-financial-kernel-runtime.test.ts` : tests de la façade, de la confiance et du store mémoire.
- `docs/internationalization/US-FINANCIAL-KERNEL-V5-20261010.md` : présent compte rendu, politique et limites.
- `docs/evidence/us-financial-kernel-v5-20261010.json` : sélection, résultats, empreintes et périmètre vérifiés.

Les rapports `.qa/us-financial-kernel` sont des preuves locales de recette, pas de nouveaux artefacts destinés aux clients. Leurs noms et empreintes sont consignés dans le fichier d'évidence.

## 3. Fichiers modifiés

Seul `docs/internationalization/STATUS-20261009.md` est actualisé parmi les fichiers existants, pour distinguer le noyau préparatoire précédent du nouveau livre financier interne. Aucun code applicatif existant, contrat public, migration historique ou fichier de la copie native n'est modifié.

Les anciens `invoiceBalance()`, exports et préparations v1–4 conservent légitimement l'hypothèse `encaissé = total - dû`. Cette hypothèse serait fausse pour une projection qui soustrait aussi des avoirs. Le nouveau livre ne doit pas être injecté dans ces projections ; leur versionnement et leur adaptation font partie de la suite.

## 4. Migrations proposées et retour arrière

**Aucune migration financière de cette phase interne en mémoire.** Aucun `db push`, backfill, changement de région, transformation d'historique, suppression, table live ou RLS n'est autorisé par cette documentation. Les migrations antérieures restent inchangées.

La future capacité persistée devra disposer d'une migration PostgreSQL additive et versionnée couvrant livre/événements/reçus, immutabilité de la baseline, droits par entreprise, écritures équilibrées, périodes, séquence/CAS, unicité et plafonds d'allocation. Elle devra ajouter une preuve source fiscale et une outbox atomique, sans emprunter l'autorité des abonnements SaaS. Les autorisations membres/abonnements D1 et les données ERP PostgreSQL demeurent des autorités distinctes ; aucun FK fictif entre elles ne suffit à autoriser une opération.

Avant une application hébergée : tester chaîne de migrations représentative et compatibilité CH/v1–4, restaurations, concurrence, révocation, privilèges, RLS et reprise après résultat incertain ; obtenir l'approbation explicite de production. Préférer une désactivation de la nouvelle capacité et un arrêt des dispatchs à la suppression de faits financiers. Dès qu'un effet fiscal externe a été envoyé, le rollback exige compensation/conciliation et ne peut consister à effacer les événements locaux.

## 5. Tests exécutés et résultats

Implémentation locale `cc020967f34000cbe8474df0ca678acbf46d7f13`, précédée par `4bdb2731579827ed644b1643bef20e505479bc90`. Régression finale : **4 551 / 4 551 tests dans 138 fichiers**, aucun échec, skip ou todo. Les 121 nouveaux tests sont inclus dans ce total, pas ajoutés une seconde fois. Les 135 fichiers de la sélection antérieure sont conservés intégralement. Le manifeste et les empreintes sont dans `docs/evidence/us-financial-kernel-v5-20261010.json`.

| Vérification | Résultat définitif / commande / rapport à renseigner |
| --- | --- |
| Moteur : promotion baseline4, replay, écritures et projections | 49 / 49, `us-financial-kernel.test.ts`. |
| Façade : autorité, preuves, CAS/concurrence et reprises exactes | 47 / 47, `us-financial-kernel-runtime.test.ts`. Autorisation recontrôlée au CAS et sur échec asynchrone ; provenance de promotion et projections de ports immuables. |
| Frontières publiques 1–4 : header, negotiation, store/read/commit, sync/delta/events | 25 / 25, `us-financial-kernel-capability.test.ts`. Refus JS effectifs de 5 ; aucun RPC d'écriture pour un commit5. |
| Régressions sélectionnées CH/US et comptabilité existante | 4 551 / 4 551 au total, sélection réelle dans `.qa/us-financial-kernel/selection-final.json`. PostgreSQL local existant exécuté avec `PGLITE_MODULE_DIR` configuré, dont 19 commandes commerciales et 14 recherches fournisseur ; aucune nouvelle migration testée ou annoncée. Tests D1 locaux sur SQLite réels ; Auth/provider fictifs, pas de preuve hébergée. |
| Typecheck et lint typé | TypeScript global `tsc --noEmit --incremental false`, exit0. `oxlint --type-aware --deny-warnings` sur les sept nouveaux fichiers TS, exit0. |
| Marque et build production | `node scripts/check-brand-assets.mjs`, exit0 ; `node node_modules/vinext/dist/cli.js build`, exit0. Notices existantes de middleware, durée de plugins, taille de chunks et classification de routes. Aucune publication. |
| Tests fournisseur/auth/base hébergés et natifs | Non exécutés dans ce périmètre interne ; ne pas les présenter comme validés. |

La régression finale utilise `--maxWorkers=2`. Le premier lancement global, conservé séparément, comptait 4 545 succès et un échec `STACK_TRACE_ERROR` dans le test existant de capacité Support ; les nouveaux tests étaient encore finalisés. Le relancement complet passe sans modification du test existant ni de son délai. Un lancement initial de TypeScript a rencontré une course de création du dossier de logs et un lancement de build utilisait un mauvais chemin CLI ; les commandes finales ont été réellement relancées. Ces essais intermédiaires ne sont ni masqués ni comptés comme réussis.

Couverture exercée : avoir partiel/total impayé ; facture partiellement payée avec avoir inférieur/égal/supérieur au dû ; encaissements avant/après avoir ; centime final, quantités fractionnaires et remises ; lignes exemptes/taxées ; preuve manquante/altérée/étrangère ; dates et périodes fermées ; relecture d'autorité et révocation ; édition de baseline/ancien événement/promotion ; double clé, contenu différent, réponse perdue, restauration du replay ; deux opérations concurrentes. Le scénario intégré vérifie également bilan, résultat, balance équilibrée et flux de trésorerie : les avoirs ne créent aucun encaissement.

## 6. Risques identifiés et sources primaires

**Reconnaissance et méthode.** L'IRS distingue recettes effectivement/constructivement reçues en cash et revenus gagnés en accrual ; la cohérence de méthode et certains changements demandent une revue spécifique. Cela relève de la fiscalité fédérale, pas d'un calendrier national de sales tax. Le noyau engagement ne peut donc pas être étendu à cash en changeant un simple libellé. [IRS Publication 538, révision 01/2022 actuellement publiée](https://www.irs.gov/publications/p538).

**Taxe en attente.** Débiter un compte de taxe dans le livre TEST ne signifie pas que la réduction est admise en déclaration ou déjà enregistrée par le fournisseur. Avant activation, faire valider le moment de reconnaissance, les cas admissibles et le traitement d'un échec de plan externe. Les rapports fiscaux définitifs devront distinguer montant historique, ajustement proposé, autorisé, envoyé et enregistré/rapproché ; `adjustment_pending` ne peut être silencieusement présenté comme une économie fiscale acquise.

**Conditions d'État.** En Californie, Regulation 1655 encadre l'exclusion de marchandises retournées, la restitution du prix/taxe et les retenues de rehandling/restocking. Ce cas illustre pourquoi la seule mécanique AR ne valide pas une réduction fiscale ; il n'est pas généralisé à tous les États, services ou remises commerciales. [CDTFA Regulation 1655](https://cdtfa.ca.gov/lawguides/vol1/sutr/1655.html).

**Reversal et double effet.** Dans le flux Stripe Tax custom/hors Stripe, un reversal est une nouvelle transaction immuable liée à l'original. Un full reversal ne neutralise pas les partial reversals précédents ; une stratégie mal séquencée peut doubler la réduction. Les lignes/montants et les limites fournisseur doivent être rapprochés, sans confondre remboursement bancaire et ajustement fiscal. Un flat amount n'est pas une preuve de sélection de la bonne ligne métier. [Stripe, reversals hors Stripe](https://docs.stripe.com/tax/off-stripe#reversals).

**Confiance et concurrence.** Le port fiscal interne et les fixtures TEST ne démontrent aucune vérification fournisseur réelle. Les timestamps/identifiants restent soumis à une autorité serveur future. Le CAS mémoire n'empêche pas deux processus indépendants d'agir ni un effet externe orphelin ; l'outbox durable et la transaction de base sont indispensables avant ce raccord. Une référence d'approbation non corroborée ne constitue pas une habilitation professionnelle.

**Historique et charge.** La baseline n'est pas un second ERP modifiable en parallèle : l'évolution d'autres modules pendant une future vie du livre nécessite une stratégie explicite de versions/rebase/replay. La validation et le replay du livre entier ne démontrent aucune latence de production, débit de 150 entreprises ou rétention illimitée. Vérifier budgets JSON, croissance des événements et contention avec données fictives avant de fixer un SLA.

Sources consultées le 10 octobre 2026 : documentation Stripe via le connecteur officiel, avec skills `stripe-docs` et `stripe-best-practices` déjà lus ; pages IRS/CDTFA consultées sur leurs domaines primaires. Aucun compte marchand, appel financier, souscription ou secret n'est utilisé. Cette note fait une distinction explicite entre faits fournisseur, règle fédérale de périmètre limité, exemple d'État et politique technique Zentra.

## 7. Fonctionnalités terminées dans le périmètre interne

Le code présent met en œuvre une promotion réservée au propriétaire depuis une vraie baseline4 engagement US/USD validée ; un livre séparé ; émission/application d'avoirs numérotés TEST sur lignes exactes, bornées par le restant dû ; encaissements ultérieurs ; écritures équilibrées et projections séparant reçu/crédit/dû ; validation complète par replay. Il vérifie périodes ouvertes, dates, chronologie de preuve/acteur, autorité financière et unicité des événements/plans. Les opérations cash, remboursements, avoirs dépassant le restant et configuration non admise sont refusées.

La façade fournit les requêtes sans preuve fiscale client, les relectures d'autorité, la résolution fiscale interne, les reçus exacts et l'adapter mémoire append-only/CAS, y compris reconstruction des reçus depuis un livre TEST restauré. Les projections des ports sont détachées avant le postcontrôle d'autorité, y compris en cas d'erreur ; les erreurs privées non typées sont remplacées par un code stable. Ces fonctions sont implémentées et vérifiées au niveau interne selon la rubrique 5. Elles ne sont pas annoncées opérationnelles aux utilisateurs.

La fermeture des capacités publiques à 1–4 est intentionnelle. Elle protège les clients actuels et ne signifie pas que le nouvel objectif financier est abandonné. Aucun écran, route HTTP, port PostgreSQL, synchronisation appareil, distribution native ou activation commerciale v5 n'est livré par ce seul lot.

## 8. Fonctionnalités expérimentales et objectif restant

Le noyau TEST interne demeure expérimental ; l'objectif d'ERP américain complet reste actif. Les éléments suivants restent à développer/intégrer et faire valider, sans être redéfinis comme définitivement hors objectif :

1. **Finance persistée complète.** Migration PostgreSQL additive, gardiens financiers/tenant/périodes, immutabilité, reçus et CAS atomiques ; tests SQL de concurrence et compatibilité ; admission D1/Auth/Gestion fraîche et contrôles lors de chaque commit. Définir la coexistence des opérations ERP et du livre, sans baseline modifiée silencieusement.
2. **Taxe d'origine et exécution.** Adapter concret vérifiant la vente réellement enregistrée, compte/mode, IDs des lignes, juridictions, motif et allocation exacte. Les calculs historiques seuls restent insuffisants. Ajouter outbox de plan/dispatch, reçu fournisseur, reprise/reconciliation et compensations ; ne jamais exécuter un reversal avant le commit ERP. Valider professionnellement le traitement avant/après paiement et son moment de déclaration.
3. **Cash basis.** Nouveau replay de la reconnaissance après remise/avoir et encaissements ; distinguer montants jamais reconnus, déjà reçus, crédits ultérieurs et remboursements. Une créance cash non encaissée n'est pas une déduction de bad debt automatique. Tester le croisement cash/accrual × impayé/partiel/payé sans double réduction ni répartition fiscale inventée.
4. **Avoirs payés, passif client et remboursements.** Avoir excédant le dû, crédit disponible, application future, passif approprié et compensation ; restitution bancaire distincte avec demande, exécution, rapprochement, échec/annulation et autorisations. Définir la correction d'un avoir par événements liés, jamais suppression de l'historique. Revoir aussi les règles de dates/périodes et les années antérieures.
5. **Schéma et transports.** Contrat public complet versionné, négociation explicite, stockage/replay, browser session, wire/delta/sync et guards ; sources financières SQL cohérentes. Aucune annonce 5 tant que le parcours bout en bout ne la prend pas réellement en charge.
6. **Appareils et interface.** Adaptation native Rust/SQLite/Tauri sur Windows/macOS/iOS/Android, onboarding et droits, écrans FR/EN/DE/IT mobiles/desktop, erreurs utiles et reprise exacte. Exports/PDF, balance client, dashboard, projets et rapports doivent séparer reçu/crédit/dû. Aucun EIN, secret ou preuve privée intégrale dans les projections/export publics.
7. **Autres verticales et intégrations.** Acomptes, récurrence, livraisons, méthodes carte/ACH/virement et rapprochement ; workflows Support/Automation financiers autorisés et idempotents, sans contourner approbations ou droits. Les abonnements SaaS Zentra restent séparés des encaissements des entreprises clientes.
8. **Validation réelle et pilote.** Validation comptable/fiscale/juridique par un professionnel qualifié, politique d'État et conservation ; recette sandbox/staging explicitement approuvée avec Auth/PG/D1/provider réels puis pilote fictif multiappareils et charge. Préserver CH, ses données et abonnements CHF ; aucun déplacement de région ou certification implicite.

L'étape suivante doit être décidée à partir des preuves de cette phase, pas d'un badge « v5 ». Aucune publication, migration hébergée, action fournisseur, modification d'abonnement CHF ou utilisation de données clients réelles n'est réalisée par cette passe documentaire.
