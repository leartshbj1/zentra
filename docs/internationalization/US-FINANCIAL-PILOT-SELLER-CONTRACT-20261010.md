# Pilote US V5 — contrat de présentation vendeur B0

10 octobre 2026. Livraison locale du préalable pur B0, sans raccord produit ni déploiement. L'objectif ERP US complet reste actif.

Code : `9bbf7ad257b8eb694d448dd3ee3600a2e1930cab`. Plan préalable committé avant code : [plan B0](US-FINANCIAL-PILOT-SELLER-CONTRACT-PLAN-20261010.md), commit `881abf2acdc3343dd227d8775da85e0f26e50b43`. [Preuve structurée](../evidence/us-financial-pilot-seller-contract-20261010.json), SHA256 `7ca77e04aaab69f86ca3d9121b65e0eb660a078a5886b06b4ef628f5bf7daf6a`, 20 artefacts locaux inventoriés. Même arbre de 3655 fichiers pour tous les contrôles : `8ad838a89ff5341936fe56ec848b7309d949aa79a75f3519fa132fca6ec7c444`.

## 1. Résumé des modifications

Le contrat de correction du nom commercial imprimé et des contacts vendeur est désormais typé, fermé et testable. Il distingue la présentation historique S0, les changements S, les observations actuelles F/B/S et les reçus dont F source est historique. Null retire explicitement un contact. Adresse, identité légale, EIN, pays, devise, fiscalité, binding et marchand sont refusés.

Une proposition pure vérifie les corrélations F/S et avant/après, compare les instants PostgreSQL à la microseconde avec offset, puis calcule deux hashes déterministes. Son application pure avance S seul et conserve exactement F/B. Un nouveau UUID peut décrire un profil identique et compte tout de même un changement. Une preuve historique peut rester structurellement valide lorsque son application au head courant est refusée.

Ces fonctions ne consultent aucune autorité et ne persistent rien. Il n'existe aucun nouveau port, store, RPC, route, session, UI, permission ou activation. Un rôle, hash, reçu ou marqueur replayed dans ces données ne fournit ni autorisation, approbation humaine, provenance DB, CAS ou replay effectif. La maintenance réelle postpromotion n'est pas livrée par B0.

## 2. Fichiers créés

| Fichier | Résultat |
| --- | --- |
| `lib/international/us-financial-pilot-seller.ts` | Requête, présentation, head composite, lecture, preuve, application et reçu purs ; captures, budgets et hashes. |
| `lib/international/us-financial-pilot-seller.test.ts` | 67 tests nouveaux, discriminants et adversariaux ; aucun port fictif présenté comme backend réel. |
| `docs/internationalization/US-FINANCIAL-PILOT-SELLER-CONTRACT-PLAN-20261010.md` | Plan arrêté avant code, exactement deux fichiers de code nouveaux. |
| `docs/evidence/us-financial-pilot-seller-contract-20261010.json` | Sources/commit/commandes/résultats/revue/artefacts corrélés. |
| `docs/internationalization/US-FINANCIAL-PILOT-SELLER-CONTRACT-20261010.md` | Présente livraison en huit rubriques. |

Le code est committé séparément du plan et de la livraison. Les scripts/logs/rapports/revue et le candidat d'intégration restent ignorés dans `.qa/us-pilot-seller-contract/` et `.qa/us-pilot-quote-pdf/` ; ils n'ajoutent aucun comportement produit.

## 3. Fichiers modifiés

`docs/internationalization/STATUS-20261009.md` reçoit ce jalon en tête. La queue historique du statut est conservée exactement, avec preuve de longueur/SHA dans `.qa/us-pilot-seller-contract/status-preservation.json`.

Aucune source existante, dépendance, CSS, police, migration ou configuration n'est modifiée. Les deux hashes de code sont identiques à ceux de la revue, des contrôles et du commit.

## 4. Migrations proposées

Aucune migration B0, aucun SQL exécuté, aucun schema/grant/RLS/trigger modifié. Aucun changement hébergé, abonnement, région, document ou donnée client.

B1 reste un candidat d'architecture non suivi : stockage additif, RPC sous admission réelle et raccord commun devis/factures. Le chemin de sa migration devra être généré par la CLI puis fixé dans son plan préalable ; aucun nom horodaté ou SQL provisoire n'est livré ici.

## 5. Tests exécutés et résultats

| Contrôle | Résultat réellement exécuté |
| --- | --- |
| Ciblés | 158/158, 4 fichiers, 1868ms : 67 nouveaux, profil vendeur66, captureJSON19, hash6. |
| Compatibilité sélectionnée | 862/862, 21 fichiers, 21378ms ; zéro échec, pending ou todo. Les158 ciblés sont compris dans ce total, sans addition des comptes. |
| TypeScript global | Exit0, 29503ms. |
| Lint typé, deux fichiers, avertissements refusés | Exit0, 2132ms. |
| Marque | Exit0, 422ms. |
| Build production | Exit0, 20881ms. |
| Revue indépendante | Lecture complète des deux fichiers gelés ; aucun finding ouvert/bloquant. Aucun contrôle exécuté par le reviewer. |

Tous ces contrôles ont été sérialisés sur l'arbre et les deux sources identiques. Les budgets4096octets requête et64KiB projections sont vérifiés après la capture structurelle ; ce n'est pas une garantie d'allocation mémoire préalable. Tests : mutations d'aliases pendant digest, attentes capturées, getters/proxies hostiles, cycles, UTF-16/NUL, champs fiscaux interdits, hashes forgés, limites sûres/S0/count1000, horloges/offsets/microsecondes, proposition périmée, F/B conservés, reçuF historique et erreurs crypto503 sans contenu sensible.

La sélection comprend facturation fiscale TEST, kernel V5, banque, commercial, exports/owner, canaris TVA/country-guard, Auth, compte et contrat Stripe. C'est une sélection de compatibilité, pas une couverture totale CH/US. Aucun QR suisse, backend hébergé, navigateur, provider réel, PostgreSQL, charge ou application native n'est testé pour B0. La recette précédente des PDF des devis (6903tests sélectionnés et26vérifications navigateur) reste un jalon distinct, documenté dans [sa livraison](US-FINANCIAL-PILOT-QUOTE-PDF-20261010.md).

## 6. Risques identifiés

- Une preuve auto-cohérente et hashée reste non autoritaire ; la future base devra reconstruire tenant, acteur, F source et présentation depuis ses propres données sous admission/verrous.
- B0 ne contient aucun livre/audit : il ne peut pas corroborer l'horloge du préfixe F ni sa provenance. B1 devra comparer aussi au temps de promotion/dernier événement du vrai F source et à l'heure serveur.
- Aucune chaîne d'historique entière n'est reconstruite ; les hashes précédents sont des données structurelles, pas des signatures ou un sceau réglementaire.
- Le contexte fiscal et la présentation commerciale ont des révisions distinctes. Les confondre casserait les corrélations verify/resolve et risquerait de modifier les hypothèses fiscales.
- Une préparation expirée actuellement reserved/calculated n'a pas de mécanisme d'annulation. B1 devra conserver sa reprise historique sans en faire un veto permanent à la correction S ; aucune extension TTL implicite.
- Aucun niveau de conformité, certification comptable, résidence supplémentaire, disponibilité ou isolation hébergée n'est déduit de ce lot pur.

## 7. Fonctionnalités terminées

Contrats exacts et captures gelées avant await ; contraintes du profil existant réutilisées sans normalisation/traduction silencieuse ; distinction S0/S/F/B ; hashes namespacés et déterministes ; proposition/application pures ; validations historiques indépendantes du head actuel ; reçu avec sourceRevision historique explicite ; plafonds/horloges et erreurs stables. Les tests, revue, plan et preuve de livraison sont finalisés.

## 8. Fonctionnalités expérimentales et prochaine priorité

La maintenance accessible du vendeur, l'admission Auth/D1/PG, la persistance atomique, les reprises durables, le polling composite, le panneau de comparaison/approbation et le raccord fiscal/documentaire restent à réaliser dans B1. Aucune gate n'est activée. Le candidat32fichiers, relu statiquement, n'est ni un plan suivi ni une preuve de fonctionnement SQL.

Avant B1 : fixer la façade du contexte facture conservant ses champs fiscaux originaux et une présentation/S commerciale séparée ; S courant pour une première réservation, S/préparation/hashes/providerKey originaux pour une reprise réservée, receipt-first pour commis, droits/F/source/merchant/TTL inchangés. Un pending issue conserve exactement son body/reviewId approuvé ; un pending prepare doit montrer son vendeur enregistré avant approbation. L'installation du lecteur/head reste distincte de write_enabled : observation S même onglet fermé, reçu exact récupérable en mode lecture seule, jamais de fallback S0 après panne ou correction. Ces invariants restent futurs.

Rollback B0 : retirer les deux modules non raccordés, sans effet persistant. B1 devra disposer de son propre plan de retour arrière conservant données/historique/lecteurs et reprises. L'ERP US complet et sa validation professionnelle, staging, déploiement et distribution native demeurent en cours.
