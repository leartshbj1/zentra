# Action Engine — noyau et registre local

Ce dossier contient le noyau TypeScript de préparation des **propositions de devis**, un registre D1 interne et la réservation durable avant analyse. Un prédicat d'autorité utilise les sessions appareil et les packs Complets Stripe réellement payés. A3 ajoute un chargeur privé de source Support déléguée et de ressources Gestion publiées ; le desktop 1.90.15 possède les sources d'un export et d'un writer SQLite privé. La compilation et les essais natifs restent bloqués par Windows App Control. Aucun déclenchement, route, IPC ou bouton n'est activé. Ne pas présenter ce lot comme un devis Gestion déjà créé en ligne.

## Frontières

- `planner.ts` : une projection fermée d’une seule entreprise, des faits littéraux, un seul appel au port de décision et des choix d’articles bornés. Les prix, unités, taxes configurées et devises viennent du catalogue. Une ambiguïté impose la revue.
- `money.ts` : cents et quantités en millièmes entiers bornés ; multiplication BigInt et arrondi positif half-up. Le montant net est indicatif de la proposition ; ce lot ne calcule pas une obligation fiscale ou une écriture comptable.
- `validation.ts` : captures indépendantes, données JSON fermées, origine entreprise, identité, révisions, preuves, montants et reçus vérifiés.
- `engine.ts` : admission fraîche, réservation avant IA, réutilisation du résultat durable sans nouvel appel, empreinte SHA-256, contrôle des versions et récupération d’un reçu avant réexécution.
- `intake.ts` : une préparation par entreprise/source/type, contexte complet hashé, bail récupérable seulement avant HTTP, marqueur durable à usage unique avant l'analyse et résultat figé avant sauvegarde de proposition. Une réponse perdue après démarrage reste incertaine ; aucun TTL ne l'autorise à rappeler le modèle.
- `provider.ts` : transport JEV existant, modèle et endpoint fixes, une tentative HTTP, sans retry ni modèle de secours. L'autorisation fraîche et le transport partagent le délai borné. Cette factory ne réserve pas elle-même la préparation : l'orchestrateur doit d'abord réussir `intake.start`.
- `production-admission.ts` : identité issue du véritable `requireDeviceSession`, rôle/siège/abonnement/paiement/remboursement vérifiés en SQL ; consentement distinct pour préparer un brouillon et créer conditionnellement son client. Lecture historique et progression sont séparées. Aucun défaut permissif, endpoint d'activation ou droit fondateur implicite.
- `published-context.ts` : source persistée sous délégation actuelle, archive Supabase publiée et authentifiée, chunk borné et vérifié, puis relecture de l'admission, de la source et de la tête. Ce chargeur n'est pas un verrou transactionnel entre D1 et Supabase.
- `published-resources.ts` : lecteur fermé des deux positions réservées au début du ZIP, SHA/CRC, JSON strict, bornes et révisions déterministes. Les faits bruts restent inchangés ; le taux effectif est zéro pour une entreprise non assujettie. Aucun taux fiscal n'est inventé.
- `source-envelope.ts` : nom littéral borné et suppression du seul préfixe mécanique corroboré. Une identité ambiguë ou inventée à partir du texte n'autorise pas la création d'un client.
- `types.ts` : ports étroits. Il n’existe aucune capacité d’émission, d’envoi d’e-mail, de paiement, de comptabilisation ou de mise à jour d’une écriture validée.

Les objets `ActionActor` sont construits par la couche d’authentification. Le navigateur, le mail et le modèle ne fournissent ni autorisation ni locataire. Les adaptateurs devront revalider l’admission au serveur et au point de commit ; les types TypeScript et les vérifications préalables ne remplacent pas une transaction.

## Registre D1 interne

`ledger.ts` conserve la proposition immuable et la réservation permanente par source. La première réservation fixe l'installation, l'acteur et les IDs métier. Aucun TTL ni transfert automatique : une exécution incertaine doit être rapprochée avant de reprendre. Retrouver les IDs ne constitue pas une nouvelle autorisation d'écrire dans Gestion.

La factory exige une barrière SQL serveur (`ledger-types.ts`) appliquée par assertion CHECK dans le même batch que la mutation et le journal. Le prédicat d'autorité privé couvre une branche explicite : appareil authentifié, pack Complet Stripe payé, activation et siège actuels, Automation en mode `suggest`, fonctions locales/globales et consentements actuels. Essais, droits manuels, prépayés ou de transition ne sont pas pris en charge. Ce prédicat **ne remplace pas** le CAS source/catalogue/identité client ni la preuve de publication. L'interface obligatoire ne doit jamais être alimentée par du SQL reçu en HTTP. La confirmation d'un reçu exige une preuve de publication canonique vérifiée par cette barrière ; elle n'accepte pas à elle seule la déclaration du navigateur ou de l'appareil. Aucun reçu n'est une preuve de conformité fiscale ou d'émission.

Les migrations proposées 0099, 0100 et 0101 sont additives et locales. La réservation 0100 ferme la course avant le premier appel : un seul propriétaire peut démarrer, un résultat fini est rejoué, un démarrage incertain n'est jamais réattribué automatiquement. Le consentement 0101 est désactivé par défaut. Aucune migration distante n'a été exécutée.

Le reçu de création décrit un vrai brouillon non numéroté : `status: 'draft'` et `quoteNumber: null`. Cela corrige l’ancienne hypothèse d’un numéro dès la création ; dans Gestion, le numéro est attribué lors de l’émission explicite du devis. Ce noyau n’autorise pas cette émission. Le reçu historique conserve `null`, même si le document est émis plus tard : `quoteId` permet d’ouvrir son état courant, sans réécrire le fait de création.

## Prochain adaptateur durable

1. Composer le chargeur privé A3 avec le prédicat d'autorité et une véritable barrière de persistance. La baseline native 1.90.15 utilise les archives `.zentra` et les révisions Supabase ; voir `docs/action-engine/PUBLISHED-CONTEXT-CONTRACT.md`. Le prototype D1 de l'ancien desktop 1.46.1 n'est pas ce protocole.
2. Unicité centrale **entreprise + ticket source + type d’action**. Une nouvelle révision du mail ne doit pas créer silencieusement un second devis. Même clé + même empreinte : reçu d’origine ; contenu différent : conflit explicite.
3. Persister la proposition et sa révision sous contrôle atomique de l’admission, de la source et du contexte. Les propositions à vérifier n’autorisent aucun commit.
4. Valider les sources natives A3 sur un hôte autorisé, puis raccorder la réservation centrale à une commande dédiée. Le writer privé revalide l'origine et les faits locaux, puis prévoit client éventuel, brouillon, lignes, reçu, audit et outbox en transaction IMMEDIATE ; il ne prouve pas l'admission distante et n'est pas exposé à la WebView.
5. Réconcilier les sources non dispatchées, les analyses incertaines et les commits locaux/distance. Une réservation d'exécution n'a pas de bail transférable ; un délai expiré n’est pas une preuve d’absence de commit. Le rapprochement manuel audité reste à construire. Ne pas promettre « exactly once » sur la seule base d’un reçu SQLite.
6. Notification de résultat uniquement après reçu métier confirmé. L’ouverture du résultat doit cibler le vrai devis existant. Sa validation, émission et transmission restent dans les parcours métier habituels.

## Limites volontaires du préparateur

Le premier contrat est prudent : CHF/USD à deux décimales, huit lignes au maximum, vingt candidats article par ligne, correspondance client par e-mail exact seulement, quantités littérales simples, pas d’interprétation de tarifs donnés par l’expéditeur. Les autres devises nécessiteront un adaptateur explicite de leur précision. Le séparateur ambigu de `1,000`/`1.000`, les demandes regroupant plusieurs quantités dans une phrase, les correspondances incertaines et les informations manquantes demandent une revue. Aucune donnée utilisateur n’est traduite ou inventée.

Les tests utilisent des données et un fournisseur fictifs, des ports en mémoire, SQLite réel et le runtime D1 local workerd/Miniflare. L'admission utilise le véritable authentificateur avec une base locale. Le chargeur utilise de vraies requêtes SQLite avec des ports auth/archive fictifs ; le codec lit des ZIP synthétiques. Les tests SQL62 exécutent le fichier natif réel via Node, pas le writer Rust. Ces essais ne prouvent pas la composition absente source/publication, une archive effectivement produite par Rust, un appel JEV en ligne, une création native, une notification système ou la synchronisation entre de vrais appareils.
