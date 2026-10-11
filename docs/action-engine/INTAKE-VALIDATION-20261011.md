# Action Engine — lot A2 local, 11 octobre 2026

## Résultat et portée

Code : `c3d92cce06ddff231522a1be2f19ba92b0aa9649`. La préparation est maintenant réservée durablement **avant** l'analyse, et son résultat est conservé avant la sauvegarde de proposition. Deux préparations concurrentes de la même source ne lancent pas deux analyses. Un accusé perdu après démarrage ne libère jamais automatiquement cette tentative.

Une factory privée construit également un prédicat d'autorité à partir du véritable authentificateur appareil et des tables commerciales existantes. Elle couvre seulement un **pack Complet Stripe actuellement payé**, avec les droits, sièges, consentements et réglages actuels. Elle n'est ni un endpoint d'activation, ni le contrôle du ticket/catalogue, ni une preuve de publication Gestion.

**Aucun véritable client ou devis Gestion n'est créé par ce lot.** Le raccord Support, la projection Gestion publiée, la composition complète des barrières, le writer natif et la supervision restent absents. Aucun appel JEV réel, déploiement, migration distante ou modification des données clients.

## Fichiers créés

- `lib/action-engine/fingerprint.ts` : empreinte de plan extraite sans changer son contrat.
- `lib/action-engine/intake-types.ts`, `intake.ts` : contrats fermés, ownership et persistance D1 de la préparation.
- `lib/action-engine/intake.test.ts` : 39 tests SQLite avec véritable historique SQL, deux connexions, réouverture et pannes.
- `lib/action-engine/intake-d1.test.ts` : 4 tests du runtime D1 local workerd/Miniflare, dont concurrence et pertes d'accusé après COMMIT.
- `lib/action-engine/provider.ts`, `provider.test.ts` : transport JEV existant à tentative unique, modèle/endpoint fixes, autorisation et délai bornés ; 15 tests avec transport fictif.
- `lib/action-engine/production-admission.ts`, `production-admission.test.ts` : prédicat privé appareil + pack Complet payé et 67 tests SQLite avec le véritable `requireDeviceSession`.
- `drizzle/0100_action_engine_quote_intake.sql` : préparation durable et journal append-only.
- `drizzle/0101_action_engine_quote_settings.sql` : consentement distinct brouillon + client conditionnel, désactivé par défaut.
- `docs/action-engine/PUBLISHED-CONTEXT-CONTRACT.md` : contrat du raccord clients/catalogue publié, encore à développer.

## Fichiers modifiés

- `lib/action-engine/engine.ts`, `engine.test.ts` : réservation avant modèle, résultat durable, reprises sans deuxième analyse, captures d'adaptateurs avant attente.
- `lib/action-engine/planner.ts` : les erreurs d'intake ne sont plus figées comme un problème métier `provider_unavailable`.
- `lib/action-engine/types.ts` : intake obligatoire dans les ports de préparation.
- `db/action-engine-schema.ts` : déclarations des tables, index et relation additive des réglages.
- `lib/action-engine/README.md` : portée réelle, branche commerciale couverte et limites restantes.
- `docs/action-engine/AUDIT.md`, `NATIVE-ADAPTER-CONTRACT.md` : correction du protocole réellement utilisé par le desktop 1.90.15.

Ce compte rendu, `STATUS.md` et le manifeste de preuves sont enregistrés dans un commit documentaire séparé. La copie native `app-current-corrections` reste propre au commit `56daec734529c06bae6dd73729c74b3a655edb86` ; le dépôt utilisateur d'origine n'a pas été modifié par ce lot.

## Invariants vérifiés

- Identité unique entreprise + source + type ; une source modifiée sous la même identité donne un conflit, pas une nouvelle analyse silencieuse.
- Hash du contexte complet, avec clients/archives/absence et catalogue triés par ID ; pas seulement des étiquettes de version.
- Seul `preparing` expiré peut changer de propriétaire. `started` et `uncertain` ne sont jamais réattribués automatiquement.
- `start` doit réussir son CAS et retourner la ligne mutée avant tout HTTP. Un accusé perdu après COMMIT ne vaut pas autorisation d'appeler.
- Plan fermé et empreinte conservés avant sauvegarde A1 ; résultat fini récupéré après perte de réponse sans rappeler le modèle.
- Erreur fournisseur, notification d'incertitude impossible ou droit révoqué : aucun second appel ni proposition métier d'échec persistée à tort.
- Fence SQL fausse ou NULL : rollback du batch et du journal. Horloge/bail construits après l'attente d'autorité, avant le batch.
- Tables WITHOUT ROWID, identités/résultats immuables et gardes de toutes les clés uniques contre REPLACE.
- Sessions/installation/entreprise figées ; révocation, rôle, siège, abonnement, période payée, remboursement et mode Stripe réévalués par le prédicat SQL.
- Les personnes en lecture seule consomment un siège. Un changement de formule peut donc retirer le droit d'une personne hors limite, sans donner un accès illimité par une valeur NULL.
- Consentement spécifique et grantor propriétaire/admin actuels ; absence de réglage ou réglage désactivé : refus de progression. Lecture historique séparée, sans permission de création implicite.
- Un seul HTTP, sans retry ni modèle de secours. Une autorisation pendante atteint le délai et n'envoie rien si elle se résout tardivement.
- Journal limité aux identités/étapes, sans contenu d'e-mail, prix, clé ou bearer ; erreurs internes masquées.

Les fences QA des tests intake/ledger prouvent l'atomicité du prédicat fourni, **pas** la composition de production encore absente. Les tests d'admission utilisent les migrations et l'authentificateur réels sur une base locale, sans session client réelle ni appel Stripe.

## Contrôles exécutés

Preuves : `docs/evidence/action-engine-intake-20261011.json` — 20 sources et 20 artefacts locaux avec SHA-256.

| Contrôle final | Résultat |
| --- | --- |
| Vitest `lib/action-engine lib/automation` | **545/545**, 20 fichiers, 0 échec, 0 en attente |
| Noyau Action Engine | 175 tests |
| Registre A1 | 63 SQLite + 7 D1 |
| Intake A2 | 39 SQLite + 4 D1 |
| Admission appareil réelle, base locale | 67 tests |
| Transport de décision à tentative unique | 15 tests |
| Régression Automation existante | 175 tests |
| TypeScript `--noEmit --incremental false` | Sortie 0 |
| Oxlint `lib/action-engine db/action-engine-schema.ts` | Sortie 0 |
| Assets de marque | Sortie 0 |
| Build production Vinext | Sortie 0 |
| `git diff --cached --check` avant commit code | Sortie 0 |

Le build conserve les avertissements existants sur `middleware` et la classification statique incomplète des routes Vinext. Il ne constitue pas une recette hébergée.

Les premières passes sont conservées : smoke 75/75 ; smoke suivant 182/183, dont un scénario de test qui ajoutait une quatrième personne à une offre trois sièges. Ce scénario a été remplacé par un vrai passage Pro → Team, sans assouplir le trigger de capacité existant. Des erreurs de typage de mocks et trois alertes lint ont également été corrigées. Les deux dernières régressions passent 545/545 ; la seconde utilise les sources finales après ces corrections.

Aucun test natif, d'appareil physique, de véritable fournisseur IA, d'abonnement Stripe en ligne, de QR-facture ou de fiscalité n'est compris dans ces résultats.

## Migrations et retour arrière

0100 et 0101 ont été créées avec la commande Wrangler de création de migration contre une configuration locale sans accès de production. Elles sont additives ; aucun historique SQL existant n'est réécrit. SQLite applique toutes les migrations réelles ; workerd applique localement 0099 + 0100 pour l'intake D1.

0100 ajoute la réservation et son journal. 0101 ajoute un consentement distinct, absent ou désactivé par défaut ; aucun seed ou endpoint ne l'active. Le décalage historique entre les fichiers SQL et le journal Drizzle 0087 reste documenté, sans régénération rétroactive.

Retour arrière opérationnel : garder le raccord désactivé, revenir au code précédent et conserver les réservations/preuves. Ne pas effacer les états `started/uncertain` pour autoriser une nouvelle analyse. Aucun DROP automatique, migration Supabase distante, changement de région ou changement d'abonnement réel.

## Risques et étapes restantes

1. Charger le véritable ticket Support et une projection autorisée clients/catalogue provenant d'une archive `.zentra` publiée. Le desktop 1.90.15 utilise Supabase collaboration ; le D1 `business_sync_*` du desktop embarqué 1.46.1 n'est pas ce protocole.
2. Composer autorité + versions source/catalogue/identité client + preuve de publication. Une lecture Supabase puis un batch D1 ne sont pas atomiques entre eux.
3. Créer une commande native dédiée : client conditionnel + brouillon non numéroté + lignes exactes + reçu + audit + outbox dans une seule transaction IMMEDIATE. Les commandes génériques actuelles client/devis ne doivent pas être chaînées.
4. Développer la réconciliation des sources non dispatchées, analyses incertaines et commits perdus. La sécurité actuelle conserve les cas incertains, mais il n'existe pas encore d'interface pour les rapprocher.
5. Raccorder Activité / À suivre / Réglages, ouvrir le véritable devis et notifier après confirmation métier corroborée.

Essais, droits fondateur/manuels, prépayés et transitions restent refusés dans ce nouveau chemin jusqu'à leurs propres preuves d'admission. Une projection JSON et son hash ne prouvent pas seuls leur égalité avec SQLite ni la création d'un devis. Aucune garantie distribuée « exactly once » n'est annoncée. L'objectif Action Engine reste actif ; les développements US sont préservés et restent mis de côté.
