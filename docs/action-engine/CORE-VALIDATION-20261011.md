# Action Engine — livraison locale du noyau, 11 octobre 2026

## Résultat

Le commit `bdc75b6404eb39d58bd5b509a3b53cffc8a29c5f` ajoute le préparateur TypeScript de propositions client/devis et les contrats étroits de son exécution future. **Il n’est pas encore raccordé à Support ou à l’écriture native Gestion.** Aucun devis réel, client réel ou notification n’a été créé par ce lot.

Le préparateur utilise les faits littéraux du mail et les articles de l’entreprise. Les prix, unités, devises et taux configurés restent ceux du catalogue. Une seule requête de décisions fermées est autorisée après les contrôles locaux ; les cas incomplets ou ambigus n’appellent pas le fournisseur. Une proposition conservée est réutilisée sans nouvel appel.

## Fichiers créés

- `docs/action-engine/AUDIT.md` : architecture réelle, écarts et plan incrémental.
- `lib/action-engine/types.ts` : acteur, contexte, proposition, reçu et ports de persistance/exécution.
- `lib/action-engine/money.ts` : calcul borné en cents/millièmes avec BigInt.
- `lib/action-engine/quantity.ts` : preuves, quantités et admissibilité lexicale communes.
- `lib/action-engine/planner.ts` : résolution client, candidats du catalogue et décisions fermées.
- `lib/action-engine/validation.ts` : captures inertes, contrôles d’entreprise, prix, quantités, preuves complètes et versions.
- `lib/action-engine/engine.ts` : orchestration, empreinte, admissions fraîches et récupération de reçu.
- `lib/action-engine/{engine,money,planner,validation}.test.ts` : quatre suites.
- `lib/action-engine/README.md` : frontières du lot et exigences des adaptateurs.

Aucun fichier applicatif préexistant modifié. Aucun déplacement massif. Les copies desktop récentes et le dépôt d’origine sont restés inchangés. La présente note, le statut et le manifeste de preuve sont ajoutés dans le commit documentaire suivant.

## Vérifications réellement exécutées

| Contrôle final | Résultat |
| --- | --- |
| Tests Action Engine + Automation existante | **323/323**, 14 fichiers : 148 nouveaux tests du noyau et 175 tests Automation |
| TypeScript du site (`tsc --noEmit --incremental false`) | Code de sortie 0 |
| Lint du dossier Action Engine | Code de sortie 0 |
| Contrôle des ressources de marque | Code de sortie 0 |
| Compilation production Vinext | Code de sortie 0 |

Les essais utilisent exclusivement des données fictives, des réponses de fournisseur fictives et des ports contrôlés. Les cas FR/EN/DE/IT vérifient la préparation déterministe ; ils ne mesurent pas la précision réelle de JEV. Aucun appel API JEV réel et aucune consommation volontaire de crédit fournisseur.

La compilation affiche l’avertissement existant de Vinext sur la classification statique de certaines routes. La réussite du build ne constitue pas un test des routes hébergées.

Premiers diagnostics conservés : trois erreurs TypeScript de typage de fixtures/descripteurs, puis des signalements lint sur les méthodes de mocks, les tableaux volontairement creux et la recherche de caractères de contrôle. Ils ont été corrigés sans désactiver les règles. Les journaux précédents restent dans `.qa/action-engine-core` ; les contrôles finaux ont ensuite été relancés avec succès.

## Protections vérifiées

- Projection et proposition d’une autre entreprise refusées.
- Identité ambiguë ou uniquement archivée soumise à revue ; aucun nom inventé depuis le texte du mail.
- Prix injecté dans le mail ignoré ; article archivé, prix ou révision modifiés refusés.
- Quantité falsifiée, preuve tronquée, preuve répétée et ligne omise refusées, même avec une empreinte recalculée.
- Réponse du modèle inconnue/malformée et confiance insuffisante soumises à revue.
- Révocation avant analyse, avant persistance, avant commit ou avant retour du résultat contrôlée.
- Reçu retrouvé avant le contrôle d’un catalogue devenu obsolète : récupération sans nouvelle écriture.
- Aucun port d’émission, d’envoi d’e-mail, de paiement ou de comptabilisation.

## Migrations

Aucune migration proposée ou exécutée dans ce premier lot. La prochaine tranche proposera une migration D1 additive pour les propositions et réservations centrales, vérifiée sur une base locale. La persistance Gestion nécessitera une transaction native dédiée, avec reçu, audit et synchronisation. Aucun changement de région ou de données Supabase.

## Limites et travail restant

Le lot est un **noyau local testé**, avec ports de persistance et d’exécution encore abstraits. Il ne prouve ni l’atomicité d’un adaptateur absent ni une exécution unique entre appareils. Restent à construire : propositions durables, reprise d’intake, réservation centrale, commande native atomique client + brouillon, rapprochement des reçus, interface intégrée et essais réels Support → Gestion.

Seules les devises CHF/USD à deux décimales sont admises. Le préparateur reste volontairement prudent : 8 lignes, 20 candidats par ligne, mail de 3 000 caractères et preuve de 600 caractères maximum pour une décision automatique. Les autres cas restent à vérifier. Les calculs de ce lot ne certifient aucun régime fiscal et ne finalisent aucun document.

Les tests CH natifs, les QR-factures, les installateurs, les appareils physiques, la base hébergée et les paiements n’ont pas été retestés dans ce lot. Aucun déploiement, aucune publication d’installateur et aucun e-mail envoyés.
