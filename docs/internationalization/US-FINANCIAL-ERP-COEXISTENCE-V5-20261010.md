# ERP US et avoirs dans un seul livre — coexistence V5

10 octobre 2026. Base : `2fa1ebdb8570d0dc380aa0c47b453c2c95dea275`, branche `codex/international-runtime`, worktree `international-site`. Ce jalon poursuit le même objectif d'ERP international complet. Il corrige une limite du noyau précédent : après promotion, les avoirs et encaissements avançaient mais les autres registres ERP restaient figés. L'audit initial demeure dans `AUDIT.md` ; les constats et résultats des phases précédentes conservent leur date et leur périmètre.

## 1. Résumé des modifications

Le livre privé `UsFinancialBookV5` conserve une seule autorité : baseline ERP4 immuable, politique TEST et événements ordonnés. Les commandes ordinaires de Gestion avancent maintenant dans ce même flux que les avoirs et encaissements. La projection courante comprend configuration, compteurs, clients, devis, factures, fournisseurs, factures et paiements fournisseurs, projets, périodes, grand livre, avoirs et règlements.

Le nouvel événement `erp_command` enregistre commande, acteur, faits privés d'émission, résultat ERP reconstruit et effets réels. Chaque événement est recalculé au replay et comparé intégralement ; modifier le commit, l'acteur, un journal ou les faits source rend le livre invalide. Une opération sans écriture, y compris une facture réellement nulle, ne reçoit pas de journal artificiel.

Pour réutiliser les règles existantes sans les dupliquer, un adaptateur interne construit une projection ERP4 éphémère. Il retire uniquement les écritures d'avoir corroborées par les crédits courants et comprime les révisions de son journal/audit. Il conserve les révisions métier globales, les sources et les fingerprints. Le moteur existant `executeErp` valide et exécute une commande dans un store de capture local ; aucun ancien RPC, serveur, sidecar ou fournisseur n'est appelé. Ensuite, les fonctions comptables existantes réadmettent séparément les effets sur le **vrai ledger V5**, qui conserve les avoirs et ses révisions originales. Les contenus des effets sont comparés, hors cette seule différence explicite de révision.

Cette projection temporaire n'est ni un store public, ni un modèle de rapport, ni une seconde comptabilité. Le commit ERP4 retenu dans l'événement est une assertion d'audit redondante, entièrement reconstruite depuis la commande ; il ne remplace jamais le ledger réel et ne peut pas être lu comme état courant par les anciens consommateurs.

### Commandes et autorité

| Commandes | Comportement dans le livre TEST |
| --- | --- |
| Clients, devis, acceptation | Registres et compteurs communs ; membres commerciaux autorisés selon les règles existantes. Les documents émis conservent leurs snapshots historiques. |
| Émission de facture | Faits fiscaux et identité vendeur obtenus par un port serveur de confiance, absents du DTO client. Validation de la source, des dates, de l'expiration et du droit financier à l'instant d'exécution. Le replay utilise les faits et l'acteur d'origine. |
| Fournisseurs, achats, règlements fournisseurs | Même révision globale et vrai journal. Les taxes d'achat US restent traitées selon le modèle US existant, sans déduction de TVA suisse. |
| Projets | Créations et modifications avec révisions métier ; un même identifiant peut être mis à jour, sans créer de nouvelle entité fictive. |
| Journaux manuels, contrepassations, périodes | Réutilisation des procédures protégées sur le ledger réel ; collisions avec des crédits masqués dans la projection refusées. Une clôture s'applique également aux avoirs et factures suivants. |
| Encaissements clients | Exclus du wrapper historique `record_payment` : le chemin V5 tient compte des avoirs avant d'admettre le montant. Reçu, crédit et dû restent distincts. |
| Initialisation, upgrade, refresh_configuration | Refusés après promotion dans ce jalon. Une future modification de configuration devra conserver juridiction/devise/méthode, snapshots émis et cohérence des consommateurs. |

L'autorité est relue autour des ports asynchrones et au CAS mémoire final. Seules les trois commandes commerciales admettent le rôle membre ; les opérations financières et leur replay exigent toujours propriétaire, administrateur ou comptable. Toutes les nouvelles opérations partagent la borne de clé de 200 caractères. Les reçus V5 sont liés à l'organisation, à l'acteur, à la demande exacte et à la révision ; une restauration les reconstruit depuis les événements validés.

La revue a trouvé et corrigé un défaut du raccourci de replay direct du store : une proposition non validée pouvait présenter une commande commerciale pour réclamer un ancien reçu financier. Ce chemin détermine désormais le droit requis depuis l'événement canonique conservé, vérifie le préfixe exact et l'acteur d'origine, puis contrôle le droit vivant avant le retour. Les corruptions d'un livre privé lu/soumis produisent un `503` stable, tandis que refus d'accès et conflits réels restent distincts. Une révocation constatée au postcontrôle conserve la priorité sur les erreurs de replay asynchrones.

## 2. Fichiers créés

- `lib/international/us-financial-kernel-erp.ts` : admission privée, capture d'une commande ERP4 et effets sur le vrai ledger.
- `lib/international/us-financial-kernel-erp.test.ts` : parcours métier mixtes, invariants de replay, périodes, projets, zéro facture et faits privés.
- `lib/international/us-financial-kernel-erp-runtime.test.ts` : façade, résolveur de faits, autorité, conflits, erreurs privées et reprises.
- `docs/internationalization/US-FINANCIAL-ERP-COEXISTENCE-V5-20261010.md` : présente livraison.
- `docs/internationalization/US-FINANCIAL-PERSISTENCE-V5-20261010.md` : conception du prochain raccord PostgreSQL ; aucune persistance n'est annoncée implémentée.
- `docs/evidence/us-financial-coexistence-v5-20261010.json` : manifeste et résultats définitifs.

## 3. Fichiers modifiés

- `lib/international/us-financial-kernel-types.ts` : union d'événements et projection métier complète.
- `lib/international/us-financial-kernel.ts` : accumulateur commun, replay des commandes ERP et autorité adaptée à la commande.
- `lib/international/us-financial-kernel-runtime.ts` : wrapper strict, résolveur privé d'émission, reçus communs, réadmission des replays et normalisation des erreurs privées.
- `lib/international/us-financial-kernel.test.ts` : narrowing de l'union et cohérence des bornes d'idempotence.
- `lib/international/us-financial-kernel-runtime.test.ts` : narrowing de l'union, sans suppression de test historique.
- `docs/internationalization/STATUS-20261009.md` : état du nouveau jalon, distinct des relevés historiques.

Le moteur ERP4, ses stores, transports, validateurs, migrations et interfaces existants ne sont pas modifiés. Les contrats publics restent fermés à 5. Aucun code CH, fichier natif ou site publié n'est modifié par cette passe.

## 4. Migrations proposées et retour arrière

**Aucune migration ajoutée ou appliquée.** La persistance reste en mémoire TEST dans un seul processus. Le document de conception prépare promotion atomique depuis la véritable baseline verrouillée, reprise des clés historiques, gel de toutes les anciennes écritures, admission des sidecars et source courante unique.

La baseline ne contient pas tous les anciens reçus ERP4. Ce jalon réserve les clés visibles et les nouveaux événements ; il ne prétend pas avoir importé les clés de tous les anciens clients/devis. La promotion durable devra les indexer sous verrou, sans troncature ou fabrication d'opération. Les règles SQL de commandes commerciales ne sont pas exécutées par le store mémoire : leur admission/version/source fraîche reste à raccorder avant d'ouvrir ce livre à une entreprise réelle.

Le prochain lot doit être additif, local et TEST : gardiens SQL, fence/ordre de verrous, validation de source, CAS et reçus, puis adapter et contrat navigateur cohérents. Les droits D1 et le PostgreSQL ne partagent pas de transaction ; un acteur JSON ou une copie asynchrone des droits ne prouve pas une révocation atomique. Cette autorité reste à définir et tester. Aucun changement de région ou migration de production ne peut être déduit de cette livraison.

Retour arrière local : laisser la nouvelle capacité fermée, conserver l'historique et revenir au commit précédent pour les fixtures non persistées. Après une future promotion durable, ne jamais dégeler ERP4 et repointer sur sa baseline devenue ancienne ; fermer les nouvelles écritures et résoudre les opérations/reçus par une procédure additive.

## 5. Tests exécutés et résultats

Implémentation locale `b526910`, précédée par `2fa1ebdb8570d0dc380aa0c47b453c2c95dea275`. Régression finale : **4 625 / 4 625 tests dans 140 fichiers**, aucun échec, skip ou todo. La sélection conserve intégralement les 138 fichiers précédents et ajoute les deux suites ERP mixtes. Les 195 tests du noyau/de la façade sont inclus une seule fois dans ce total ; l'accroissement net est de 74 tests par rapport aux 4 551 précédents.

| Vérification réellement exécutée | Résultat |
| --- | --- |
| Noyau financier existant étendu | 50 / 50 ; un test net supplémentaire, aucun test historique supprimé. |
| Pont métier ERP mixte | 32 / 32 ; vrai moteur ERP, capture/delta et effets réadmis sur ledger V5, avec données fictives. |
| Façade financière historique | 47 / 47 ; intégralement conservés avec narrowing de l'union. |
| Façade ERP mixte | 41 / 41 ; autorité, faits privés, CAS, réponse perdue, corruption et replays directs protégés. |
| Barrières publiques ERP1–4 | 25 / 25 ; version 5 toujours refusée par les anciens transports/stores. |
| Régression CH/US sélectionnée | 4 625 / 4 625 au total ; manifeste `.qa/us-financial-coexistence/selection-final.json`. Les suites PostgreSQL existantes exécutent réellement 19 tests de commandes commerciales et 14 de lookup fournisseur avec PGlite local configuré ; aucune nouvelle persistance financière testée. |
| Typecheck | `node node_modules/typescript/bin/tsc --noEmit --incremental false`, global, exit0. |
| Lint typé | `node node_modules/oxlint/bin/oxlint --type-aware --deny-warnings` sur les huit fichiers TS de cette phase, exit0. |
| Marque et build production | `node scripts/check-brand-assets.mjs` et `node node_modules/vinext/dist/cli.js build`, exit0. Notices existantes middleware/proxy, temps des plugins, chunks volumineux et classement de routes ; aucune publication. |
| UI, appareils et services réels | Aucun nouveau parcours UI ou binaire ; pas de test Auth/PG/Stripe/fournisseur hébergé annoncé. |

Les commandes définitives, résultats par fichier et empreintes de rapports sont consignés dans `docs/evidence/us-financial-coexistence-v5-20261010.json`. Les tests D1 existants emploient SQLite local ; l'Auth et les faits fournisseur restent fictifs. Ces preuves ne certifient pas une installation de production, une transaction multiconnexion ou le fonctionnement de toutes les pages/natives.

Les nouvelles suites exercent notamment : avoir puis nouvelle vente, facture nulle, paiement réel puis modification commerciale, achat avec taxe US incorporée au coût, projet modifié, journal manuel et contrepassation, clôture/ouverture et refus ultérieur, conservation des snapshots, expiration historique au replay, tax facts malformés/étrangers/expirés, appel concurrent, réponse perdue, restauration et droit révoqué. Le parcours intégré vérifie AR/AP, recettes, résultat, bilan équilibré et trésorerie depuis le ledger réel.

Les premiers essais de la nouvelle suite de façade ont trouvé deux échecs causés par les mêmes champs de requête fiscale supplémentaires dans une fixture. Après correction, toutes les suites ciblées passent ; un nom de champ de rapport et le nombre attendu d'opérations ont aussi été corrigés avant leur première exécution complète. Le premier typecheck a trouvé les deux accès à `posting`/`record` désormais soumis au narrowing d'union dans l'ancien test ; corrigés sans suppression de test. Les logs intermédiaires sont conservés dans `.qa/us-financial-coexistence`. La tentative de revue via pnpm s'est arrêtée avant tests avec `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` ; aucune réinstallation n'a été faite. La validation définitive utilise les exécutables Node déjà présents.

## 6. Risques identifiés

Le livre et les événements restent privés. Les faits fiscaux TEST ne corroborent aucune Tax Transaction réelle, aucun reversal, remboursement ou permission réglementaire. La politique précédente et ses références primaires demeurent applicables : voir `US-FINANCIAL-KERNEL-V5-20261010.md`. Aucun nouveau taux, règle nationale, tarif ou engagement de conformité n'est introduit.

Les limites de `snapshotPrivateJson` s'appliquent à l'ensemble capturé : tableaux de 1 000 éléments, 50 000 valeurs, profondeur 20 et 2 097 152 caractères UTF-16 cumulés. Baseline, commandes, faits, commit et effets consomment ces limites ensemble, avec duplication d'audit. La borne de 1 000 événements n'est pas une capacité utilisable garantie ; une autre limite peut être atteinte bien avant. Le replay complet n'est pas une preuve de performance, de rétention ou de scalabilité. Le stockage durable devra résoudre croissance, pagination et checkpoints vérifiables sans créer de deuxième autorité.

Les anciens sidecars et exports lisent encore ERP4 ; après une future promotion durable, ils doivent lire une source V5 cohérente ou refuser explicitement les nouvelles actions. Ne pas présenter la baseline figée comme un état actuel, injecter cette projection dans un ancien rapport ou calculer reçu = total − dû lorsqu'il existe des avoirs. Le tableau des dépendances se trouve dans le document de persistance.

## 7. Fonctionnalités terminées dans ce périmètre

Une entreprise US fictive peut poursuivre ses opérations ordinaires après son premier avoir dans le noyau TEST : clients/devis/factures, achats/paiements fournisseurs, projets, journaux et périodes avancent avec les crédits et encaissements dans le même flux. Les rapports du vrai ledger et les règlements restent cohérents. Les modifications sont locales et réutilisent le moteur existant ; aucune nouvelle application indépendante n'est créée.

## 8. Fonctionnalités expérimentales et suite du même objectif

Le livre est **expérimental, interne et en mémoire**. Le jalon suivant doit raccorder ce même livre à PostgreSQL puis au navigateur TEST, avec promotion/CAS/reçus, autorité et gel sûrs, sources sidecars actuelles, projections publiques filtrées, synchronisation et exports. Il ne doit pas devenir une branche isolée de Gestion/Support/Automation.

Restent également : cash basis et crédits déjà payés/excédentaires, passif client/remboursements, acomptes/récurrence/livraisons, outbox fiscale avec source réelle et reconciliation, workflows Support et rendez-vous, abonnements US approuvés, UI et appareils alignés, tests réels autorisés et examen professionnel fiscal/comptable/juridique. La recette actuelle ne valide ni Auth/Stripe/PG hébergés, ni fournisseur réel, ni applications natives. Aucun IPA/APK/DMG/installateur ou déploiement n'est réalisé par ce jalon. L'objectif complet reste actif.
