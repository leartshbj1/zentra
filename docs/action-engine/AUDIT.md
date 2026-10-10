# Zentra Action Engine — audit initial, 11 octobre 2026

## Périmètre et autorité

Le nouvel objectif Action Engine remplace le développement US en cours. Le plan de relevé client US du commit `e9096df` reste historique ; aucun de ses quinze fichiers source n’a été modifié. Aucun déploiement, migration distante, envoi d’e-mail ou modification des données clients n’est autorisé par cette livraison locale.

Audit effectué dans `international-site` (serveur, HEAD `e9096df`) et dans `app-current-corrections` (natif 1.90.15, HEAD `56daec7`). Le desktop 1.46.1 embarqué dans la copie serveur n’est pas une base de distribution. Le site hébergé a retourné la version 355 ; cela ne prouve pas l’identité du code local et du code déployé.

## Ce qui fonctionne déjà dans le code

| Rôle | Raccord vérifié |
| --- | --- |
| Réception, déduplication et classification | `lib/support/service.ts:1093–1115`, `1280–1296` ; données Support dans D1, pièces dans R2 |
| Déclenchement après classement | `lib/support/service.ts:1410` → `dispatchMailWorkflows` |
| File durable, baux, reprises | `lib/automation/workflows.ts:251–367`, `491–546`, `613–660` ; migration `0059_careless_proteus.sql` |
| Autorité de l’entreprise et abonnement | `lib/automation/execution.ts:12–96`, `entitlement.ts:16–78` ; délégation enregistrée, membre actuel, siège, Gestion et Automation, consentement et fonctionnalités activées |
| Décisions fermées JEV | `lib/automation/provider.ts` ; réponses bornées et vérifiées, aucun JSON métier libre |
| Extraction avec preuve | `lib/supplier-inbox/extraction.ts:61–193` ; candidats littéraux puis sélection et validation |
| Écriture métier native | 1.90.15 : `database.rs` création client et `save_document_with_items_once`, `commands.rs`, `bridge.ts` |
| Synchronisation | SQLite locale, archives Supabase, protocole business-sync ; clients, devis et lignes figurent dans `business_sync_tables.json` |
| Supervision | `AutomationHub`, `AutomationJournal`, `AutomationDailySummary` ; activité, à suivre, réglages ; origine entreprise et membre |

## Ce qui manque réellement

- Les actions de workflow sont actuellement `task`, `notify`, `reply_draft`, `summary`, `review`. `create_quote` dans les politiques classe une intention ; le raccourci natif ouvre un formulaire vide.
- Il n’existe pas encore de résolution client/catalogue ni de plan client + devis sourcé et validé.
- Support/Automation D1 ne constituent pas des tables CRUD Gestion. Les archives Supabase sont des snapshots, pas une API d’écriture de devis. Écrire directement dans `business_sync_versions` contournerait le protocole.
- Deux appels successifs « créer client », « créer devis » ne sont pas atomiques. Les UUID aléatoires ne garantissent pas la reprise après perte de réponse.
- Un reçu local seul ne garantit pas l’unicité entre deux appareils : une réservation centrale et un rapprochement des reçus sont nécessaires.
- Le calcul natif existant des lignes utilise encore des flottants (`database.rs:7114–7145`). Le nouveau moteur devra utiliser des quantités en millièmes et des cents bornés, avec vérification équivalente au point de commit.
- Le dernier dispatch Support masque les erreurs : un ticket durable sans run peut rester sans reprise. Il faut une réconciliation de l’intake, pas seulement une reprise des runs existants.
- La navigation de résultat Automation n’a pas encore de raccord explicite client/devis existant. Une notification ne doit annoncer un devis créé qu’après reçu métier confirmé.

## Capacité JEV vérifiée

Le contrat officiel `https://api.typesafe.ai/openapi.json` expose des décisions `Choice`, `Score`, `Noul`, pas de génération libre. Les guides TypeSafe recommandent de proposer des candidats extraits par le code et de sélectionner parmi eux :

- https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook
- https://docs.typesafe.ai/cookbooks/function_calling
- https://docs.typesafe.ai/patterns/confidence-routing

Conséquence : noms/coordonnées provenant de faits littéraux, quantités déterministes, sélection d’articles parmi les identifiants autorisés, prix uniquement issus du catalogue. Une information absente ou ambiguë reste à vérifier. La confiance ne vaut jamais autorisation.

## Plan incrémental

1. **Noyau pur et testé** : contrats fermés, validation de projection entreprise, preuves et quantités, résolution client, décisions JEV bornées, arrondis exacts, plan de brouillon uniquement. Aucun effet de bord ni accès DB pour le modèle.
2. **Propositions durables** : file et reprise d’intake, unicité entreprise/source/action, révision/hash et approbation figés, admission fraîche, réutilisation des décisions. Migration D1 additive testée localement avant demande de déploiement.
3. **Exécution Gestion** : adaptateur natif 1.90.15 dédié ; réservation centrale, transaction SQLite client éventuel + devis/lignes + reçu + audit + synchronisation. Conflits et réponses perdues réconciliés. Ne pas annoncer un fonctionnement autonome tous appareils avant ces essais.
4. **Supervision intégrée** : une ligne d’activité, « Ouvrir le devis » réel, ambiguïtés dans « À suivre », détails repliés ; quatre langues, mobile et origine membre préservés.
5. **Autres actions** : factures, rendez-vous, fournisseurs, relances et instructions directes ; contrats distincts, validations sensibles et idempotence propres. Aucun paiement, envoi, émission ou écriture comptable implicite.

## Contrôles requis

Tests adversariaux : locataire étranger, membre révoqué, abonnement expiré, référence arbitraire, prix dans le mail, prompt injection, fournisseur/client homonyme, quantité absente ou excessive, article archivé, catalogue modifié, faible confiance, replay, double appareil, source modifiée, crash entre commit et accusé, montants hors bornes. Les tests du noyau ne prouvent pas la livraison native ou le fonctionnement en production.

## Fichiers prévus

Premier lot : `lib/action-engine/{types,validation,money,planner,engine}.ts` et tests associés ; documentation de contrats et résultats. Les migrations, routes et adaptateurs natifs seront inventoriés au lot correspondant. Préserver les contrôles CH, les abonnements, les documents et les preuves US existants.
