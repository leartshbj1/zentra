# Action Engine — premier lot local

Ce dossier contient le noyau TypeScript de préparation des **propositions de devis**. Il ne possède pas encore d’adaptateur de production D1/SQLite et n’est pas raccordé au déclenchement Support ou à un bouton de l’application. Ne pas le présenter comme un devis Gestion déjà créé.

## Frontières

- `planner.ts` : une projection fermée d’une seule entreprise, des faits littéraux, un seul appel au port de décision et des choix d’articles bornés. Les prix, unités, taxes configurées et devises viennent du catalogue. Une ambiguïté impose la revue.
- `money.ts` : cents et quantités en millièmes entiers bornés ; multiplication BigInt et arrondi positif half-up. Le montant net est indicatif de la proposition ; ce lot ne calcule pas une obligation fiscale ou une écriture comptable.
- `validation.ts` : captures indépendantes, données JSON fermées, origine entreprise, identité, révisions, preuves, montants et reçus vérifiés.
- `engine.ts` : admission fraîche, réutilisation d’une proposition existante sans nouvel appel IA, empreinte SHA-256, contrôle des versions et récupération d’un reçu avant réexécution.
- `types.ts` : ports étroits. Il n’existe aucune capacité d’émission, d’envoi d’e-mail, de paiement, de comptabilisation ou de mise à jour d’une écriture validée.

Les objets `ActionActor` sont construits par la couche d’authentification. Le navigateur, le mail et le modèle ne fournissent ni autorisation ni locataire. Les adaptateurs devront revalider l’admission au serveur et au point de commit ; les types TypeScript et les vérifications préalables ne remplacent pas une transaction.

## Prochain adaptateur durable

1. Dériver l’entreprise de la délégation Support → Gestion enregistrée. Vérifier membre actuel, siège, abonnement Gestion + Automation, consentement et activation de l’action. Charger le ticket et le catalogue par des projections autorisées.
2. Unicité centrale **entreprise + ticket source + type d’action**. Une nouvelle révision du mail ne doit pas créer silencieusement un second devis. Même clé + même empreinte : reçu d’origine ; contenu différent : conflit explicite.
3. Persister la proposition et sa révision sous contrôle atomique de l’admission, de la source et du contexte. Les propositions à vérifier n’autorisent aucun commit.
4. Réserver l’exécution centrale ; transmettre un contrat figé à une commande native dédiée. Dans une transaction locale unique : admission/origine, client éventuel, devis brouillon, lignes, calcul exact, reçu, audit et sortie de synchronisation.
5. Réconcilier les réponses perdues et les commits locaux/distance avant de réattribuer un bail. Un délai expiré n’est pas une preuve d’absence de commit. Ne pas promettre « exactly once » sur la seule base d’un reçu SQLite.
6. Notification de résultat uniquement après reçu métier confirmé. L’ouverture du résultat doit cibler le vrai devis existant. Sa validation, émission et transmission restent dans les parcours métier habituels.

## Limites volontaires du préparateur

Le premier contrat est prudent : CHF/USD à deux décimales, huit lignes au maximum, vingt candidats article par ligne, correspondance client par e-mail exact seulement, quantités littérales simples, pas d’interprétation de tarifs donnés par l’expéditeur. Les autres devises nécessiteront un adaptateur explicite de leur précision. Le séparateur ambigu de `1,000`/`1.000`, les demandes regroupant plusieurs quantités dans une phrase, les correspondances incertaines et les informations manquantes demandent une revue. Aucune donnée utilisateur n’est traduite ou inventée.

Les tests utilisent un fournisseur fictif et des ports en mémoire. Ils vérifient le noyau et ses refus ; ils ne prouvent pas l’atomicité d’un adaptateur encore absent, une intégration JEV en ligne, une notification système ou la synchronisation entre de vrais appareils.
