# Action Engine — noyau et registre local

Ce dossier contient le noyau TypeScript de préparation des **propositions de devis** et un registre D1 interne. L'admission de production, la vérification des publications Gestion et la commande SQLite native restent à raccorder ; aucun déclenchement Support, route ou bouton de l'application n'est activé. Ne pas le présenter comme un devis Gestion déjà créé.

## Frontières

- `planner.ts` : une projection fermée d’une seule entreprise, des faits littéraux, un seul appel au port de décision et des choix d’articles bornés. Les prix, unités, taxes configurées et devises viennent du catalogue. Une ambiguïté impose la revue.
- `money.ts` : cents et quantités en millièmes entiers bornés ; multiplication BigInt et arrondi positif half-up. Le montant net est indicatif de la proposition ; ce lot ne calcule pas une obligation fiscale ou une écriture comptable.
- `validation.ts` : captures indépendantes, données JSON fermées, origine entreprise, identité, révisions, preuves, montants et reçus vérifiés.
- `engine.ts` : admission fraîche, réutilisation d’une proposition existante sans nouvel appel IA, empreinte SHA-256, contrôle des versions et récupération d’un reçu avant réexécution.
- `types.ts` : ports étroits. Il n’existe aucune capacité d’émission, d’envoi d’e-mail, de paiement, de comptabilisation ou de mise à jour d’une écriture validée.

Les objets `ActionActor` sont construits par la couche d’authentification. Le navigateur, le mail et le modèle ne fournissent ni autorisation ni locataire. Les adaptateurs devront revalider l’admission au serveur et au point de commit ; les types TypeScript et les vérifications préalables ne remplacent pas une transaction.

## Registre D1 interne

`ledger.ts` conserve la proposition immuable et la réservation permanente par source. La première réservation fixe l'installation, l'acteur et les IDs métier. Aucun TTL ni transfert automatique : une exécution incertaine doit être rapprochée avant de reprendre. Retrouver les IDs ne constitue pas une nouvelle autorisation d'écrire dans Gestion.

La factory exige une barrière SQL serveur (`ledger-types.ts`) appliquée par assertion CHECK dans le même batch que la mutation et le journal. Le lot ne fournit **pas** encore le prédicat couvrant toutes les branches commerciales et sessions réelles : cette interface obligatoire ne doit jamais être alimentée par du SQL reçu en HTTP. La confirmation d'un reçu exige une preuve de publication canonique vérifiée par cette barrière ; elle n'accepte pas à elle seule la déclaration du navigateur ou de l'appareil. Aucun reçu n'est une preuve de conformité fiscale ou d'émission.

Le registre rend une reprise durable possible, mais les deux appels IA concurrents avant la première sauvegarde restent possibles. Le prochain raccord de l'intake devra aussi réserver la préparation avant l'appel fournisseur. La migration proposée 0099 est additive et locale ; aucune migration distante n'a été exécutée.

Le reçu de création décrit un vrai brouillon non numéroté : `status: 'draft'` et `quoteNumber: null`. Cela corrige l’ancienne hypothèse d’un numéro dès la création ; dans Gestion, le numéro est attribué lors de l’émission explicite du devis. Ce noyau n’autorise pas cette émission. Le reçu historique conserve `null`, même si le document est émis plus tard : `quoteId` permet d’ouvrir son état courant, sans réécrire le fait de création.

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
